# Security Model & Threat Analysis

The entire design of **MCP Pages** and **`ai-proxy`** is anchored on one foundational premise:

> **All repositories published under `https://<user>.github.io/<repo>/` share the exact same browser `Origin` (`https://<user>.github.io`). Therefore, neighboring pages on the same origin MUST be assumed hostile.**

In standard web security, the browser's Same-Origin Policy (SOP) isolates applications from one another. On multi-project static hosting platforms like GitHub Pages (`<user>.github.io`), GitLab Pages (`<user>.gitlab.io`), or shared corporate intranet domains, SOP does **not** isolate `https://example.github.io/trusted-repo/` from `https://example.github.io/untrusted-experiment/`:
- Both pages send the exact same `Origin: https://example.github.io` header.
- Both pages share the exact same `window.localStorage`, `window.sessionStorage` (within a tab navigation), `IndexedDB`, and origin-wide cookies.

Every security rule below is mandatory, enforced in code, and verified by dedicated unit and integration tests.

---

## Threat Matrix Overview

```mermaid
flowchart LR
  A1["Attack 1: Sibling repo on *.github.io reads localStorage to steal tab key"] -->|Blocked by| R1["Rule 1: Per-Page Key in Fragment -> history.state only"]
  A2["Attack 2: Sibling repo /evil on same origin spoofs allowed /good repo"] -->|Blocked by| R2["Rule 2: URL Prefix Allowlist (path boundary aware)"]
  A3["Attack 3: Malicious web page calls /mcp directly via fetch()"] -->|Blocked by| R3["Rule 3: Reject any /mcp request with an Origin header"]
  A4["Attack 4: Prompt injection via /v1 chat triggers state-mutating tools"] -->|Blocked by| R4["Rule 4: /v1 allows only named --allow-tool readOnlyHint:true tools"]
  A5["Attack 5: Web page steals admin key or hijacks /admin/v1/open-dashboard"] -->|Blocked by| R5["Rule 5: Separate Admin Key in ai-proxy-opened tab + origin-locked rate-limited open-dashboard"]
  A6["Attack 6: Rogue site tricks AI agent into silently adding/removing sites"] -->|Blocked by| R6["Rule 6: add_site / remove_site marked readOnlyHint:false + explicit user-intent prompt"]
  A7["Attack 7: Open-origin /v1 mode abused by random websites to invoke tools or drain quota"] -->|Blocked by| R7["Rule 7: allow-origin * is pure chat (0 tools), manual opt-in, TTL-bound, with prominent warnings"]
```

---

## The Seven Security Baselines

### Rule 1: Per-Page URL Key Handoff via Fragment to `history.state`

- **Rule**: Every normalized page URL has its own unique cryptographic key. `ai-proxy` passes the key to the browser tab via the URL fragment (`#mcp-key=<key>&mcp-port=<port>`). Immediately upon load, the tab reads the fragment, stores the key inside `window.history.state`, scrubs the fragment from the URL bar using `history.replaceState`, and **never** writes the key to `localStorage`, `sessionStorage`, `IndexedDB`, or cookies.
- **Attacks Blocked**:
  1. **Same-Origin Storage Theft**: If `https://example.github.io/docs/mcp.html` stored its `mcp-key` in `localStorage`, any sibling page at `https://example.github.io/untrusted-game/` could read `localStorage.getItem(...)`, steal the key, and impersonate `/docs/mcp.html` to `ai-proxy`. Because `history.state` is scoped strictly to the specific history entry in that specific tab, sibling pages on the same origin cannot read it.
  2. **Referer & Server Log Leakage**: URL fragments (`#...`) are never sent in HTTP requests or `Referer` headers, and scrubbing via `history.replaceState` prevents shoulder-surfing or accidental copy-pasting of the secret key from the address bar.
  3. **Cross-Page Key Reuse**: Because each normalized page URL has a distinct key, even if one page's key were compromised, it cannot authenticate `/tab/v1/hello` for any other page URL.

---

### Rule 2: Path-Aware URL Prefix Allowlist (Localhost Always Allowed)

- **Rule**: `ai-proxy` only serves `/mcp` and `/tab/v1/*` for target URLs that match an entry in the URL prefix allowlist (`matchesPrefix`), where prefix comparison enforces path segment boundaries—never origin-only matching. `localhost`, `127.0.0.1`, and `[::1]` are always allowed.
- **Attacks Blocked**:
  1. **Same-Origin Sibling Repo Spoofing**: Allowing `https://example.github.io/project-a` permits `https://example.github.io/project-a/mcp.html`, but blocks `https://example.github.io/project-b/mcp.html` and prefix-lookalikes such as `https://example.github.io/project-a-evil/mcp.html`.
  2. **Drive-By Tab Registration**: An unallowed page that somehow discovers the local `ai-proxy` port cannot register tools via `/tab/v1/hello` because both the allowlist prefix check and the per-page key check reject it with `403`/`401`.

---

### Rule 3: `/mcp` Rejects Requests Carrying an `Origin` Header

- **Rule**: Any HTTP request to `/mcp` (or `/mcp/*`) that includes an `Origin` header is immediately rejected with `403 Forbidden`.
- **Attacks Blocked**:
  1. **Cross-Site / Same-Origin Browser-as-MCP-Client Attack**: Every browser `fetch()` or `XMLHttpRequest` to `http://127.0.0.1:8788/mcp` from a web page (`https://...` or `http://...`) automatically attaches an unforgeable `Origin` header. By rejecting any `/mcp` request with an `Origin` header, **no web page can ever act as an MCP client** to list or invoke tools on connected tabs. Only local non-browser processes (Claude Code, CLI tools, stdio bridges) can call `/mcp`.

---

### Rule 4: `/v1` Exposes Only Explicitly Named Read-Only Tools

- **Rule**: When a web page calls the local chat completions endpoint (`/v1/chat/completions`), the model can only access tools that satisfy **both** conditions:
  1. The tool's `annotations.readOnlyHint` is strictly `true`, AND
  2. The tool was individually enabled via `--allow-tool mcp__<server>__<tool>` (enabling an entire MCP server or using wildcards is forbidden).
- **Attacks Blocked**:
  1. **Indirect Prompt Injection -> Destructive Tool Execution**: A web page using `/v1` ("Ask AI") processes untrusted text or user input. If the model had access to write/mutating tools (such as `add_site`, `remove_site`, or file/system tools), a prompt injection payload in page content could trick the model into mutating configuration or user data. Requiring both `readOnlyHint: true` and explicit per-tool `--allow-tool` naming ensures web-initiated chat can never trigger state changes.

---

### Rule 5: Isolated Admin Key & Origin-Locked, Rate-Limited `open-dashboard`

- **Rule**:
  1. `/admin/v1/*` uses a dedicated `admin-key` separate from all per-page `mcp-key`s.
  2. Only the registered dashboard page opened by `ai-proxy` itself receives `#admin-key=...` (which is immediately moved into `history.state`).
  3. The **only** unauthenticated admin route is `POST /admin/v1/open-dashboard`. It strictly verifies that the request `Origin` matches the registered dashboard origin, opens only the pre-registered dashboard URL in the browser, **never** returns the `admin-key` in the HTTP response body, and enforces a strict rate limit (`429 Too Many Requests`).
- **Attacks Blocked**:
  1. **Admin Key Exfiltration via Fetch**: If `/admin/v1/open-dashboard` returned the admin key in its JSON response, any script sharing the dashboard's origin (`https://<user>.github.io`) could call `fetch('/admin/v1/open-dashboard')`, read the key, and take full control of `ai-proxy` (allowing malicious sites, rotating keys, enabling origins). By only opening a browser tab to the registered dashboard path with `#admin-key=...` in the fragment, the caller receives only `{"ok": true}` and cannot read the new tab's `history.state`.
  2. **Open-Redirect / Arbitrary URL Launch**: Because `open-dashboard` ignores any URL in the request body and only opens the relay's registered dashboard URL, an attacker cannot trick `ai-proxy` into sending `#admin-key=...` to an attacker-controlled page.
  3. **Tab-Bombing DoS**: Rate limiting on `POST /admin/v1/open-dashboard` prevents a script from repeatedly spawning hundreds of browser tabs.

---

### Rule 6: Mutating MCP Tools Marked Non-Read-Only with Explicit User-Intent Guardrails

- **Rule**: Tools that modify `ai-proxy` state (`add_site`, `remove_site` on the built-in MCP page) MUST set `annotations: { readOnlyHint: false, destructiveHint: true }` and include an explicit instruction in their `description` stating: *"Only call this tool when the human user has explicitly asked to add/remove that specific site."*
- **Attacks Blocked**:
  1. **Unprompted AI Tool Mutation**: AI coding assistants (like Claude Code) auto-approve `readOnlyHint: true` tools in many workflows, but pause to prompt the human for confirmation before executing `readOnlyHint: false` tools. Marking `add_site` and `remove_site` as non-read-only guarantees a human-in-the-loop confirmation prompt before any site is added or removed.

---

### Rule 7: Wildcard `/v1` Origin (`allow-origin *`) is Pure Chat, Manual, TTL-Bound, and Loud

- **Rule**: Enabling "any origin can call `/v1`" (`allow-origin *`) MUST:
  1. Be strictly **pure chat** (zero MCP tools exposed, overriding even `--allow-tool` flags),
  2. Require explicit manual activation by the user (never enabled by default),
  3. Support an automatic expiration timer (`--ttl <seconds>` / `expiresAt`), and
  4. Display prominent security warnings in CLI output (`sites`, `doctor`, `serve`) and at the top of the Dashboard and MCP pages while active.
- **Attacks Blocked**:
  1. **Cross-Web Tool Abuse & Silent Quota Drain**: While wildcard origin mode is active, any website visited in the browser can send prompts to `http://127.0.0.1:8788/v1/chat/completions`. Forcing zero tools prevents arbitrary websites from probing local MCP tools, and TTL + prominent warnings ensure the user never leaves wildcard chat open unintentionally.
