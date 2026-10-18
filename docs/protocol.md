# Wire Protocol Reference

This document specifies every HTTP request, response, header, status code, and JSON-RPC payload handled by `ai-proxy` (`127.0.0.1:8788` by default) and the browser tab client (`web/*.mjs`).

---

## 1. Common CORS & Chrome Local Network Access Rules

Because browser tabs hosted on `https://<user>.github.io` make cross-origin requests to `http://127.0.0.1:8788`, `ai-proxy` MUST attach CORS headers to **all** responses on browser-facing routes (`/tab/v1/*`, `/v1/*`, `/admin/v1/*`, `/healthz`), **including all error and rejection responses (`400`, `401`, `403`, `404`, `409`, `429`, `500`, `502`, `504`)**. Without CORS headers on rejections, `fetch()` throws a generic network `TypeError`, making it impossible for the web page to distinguish "ai-proxy is not running" from "ai-proxy rejected the request".

### Required Response Headers for Browser Routes
When the request includes an `Origin` header:
```http
Access-Control-Allow-Origin: <request Origin>
Vary: Origin
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-AI-Proxy-Confirm
Access-Control-Allow-Private-Network: true
Access-Control-Max-Age: 600
```

### `OPTIONS` Preflight & Private Network Access (LNA)
When a browser sends an `OPTIONS` preflight (including `Access-Control-Request-Private-Network: true`), `ai-proxy` responds immediately with `204 No Content` and the headers above.

### Liveness Probe (`GET /healthz` or `GET /tab/v1/probe`)
Pages without a key can detect whether `ai-proxy` is running by issuing `fetch("http://127.0.0.1:8788/healthz", { mode: "no-cors" })`.
- **Response (`200 OK`)**:
  ```json
  { "ok": true, "service": "ai-proxy", "version": "1.0.0" }
  ```

---

## 2. MCP Streamable HTTP Endpoints (`/mcp`)

AI coding tools connect to `ai-proxy` using MCP Streamable HTTP (JSON response mode).

### 2.1 URL Forms
Both URL forms resolve to the same normalized page URL:
1. **Query form**: `POST /mcp?url=https%3A%2F%2Fexample.github.io%2Fdocs%2Fmcp.html`
2. **Path form**: `POST /mcp/example.github.io/docs/mcp.html` (defaults to `https://`, or `http://` when host is `localhost` or `127.0.0.1`)

### 2.2 Security & Transport Guards on `/mcp`
| Condition | HTTP Status | Response Body | Reason |
| :--- | :--- | :--- | :--- |
| Request contains `Origin` header | `403 Forbidden` | `{"error":"Origin header is not allowed on /mcp"}` | Prevents web pages from acting as MCP clients |
| `GET /mcp...` (SSE stream attempt) | `405 Method Not Allowed` | `{"error":"SSE GET not supported; use POST"}` (with `Allow: POST`) | Claude Code probes `GET /mcp` for SSE; `405` tells it to use JSON `POST` |
| Missing or invalid target URL | `400 Bad Request` | `{"error":"Invalid or missing target URL"}` | Malformed target URL |
| Target URL not in allowlist (and not localhost) | `403 Forbidden` | `{"error":"URL not in allowlist","url":"..."}` | Blocks unauthorized sites |

### 2.3 Relay-Handled JSON-RPC Methods
Claude Code sends `protocolVersion: "2025-11-25"` and probes `server/discover` before initializing.

1. **`server/discover`**:
   - **Request**: `{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}`
   - **Response (`200 OK`)**:
     ```json
     {
       "jsonrpc": "2.0",
       "id": 1,
       "error": { "code": -32601, "message": "Method not found: server/discover" }
     }
     ```
2. **`initialize`**:
   - **Request**:
     ```json
     {
       "jsonrpc": "2.0",
       "id": 1,
       "method": "initialize",
       "params": {
         "protocolVersion": "2025-11-25",
         "capabilities": {},
         "clientInfo": { "name": "claude-code", "version": "1.0.0" }
       }
     }
     ```
   - **Response (`200 OK`)**:
     ```json
     {
       "jsonrpc": "2.0",
       "id": 1,
       "result": {
         "protocolVersion": "2025-11-25",
         "capabilities": { "tools": { "listChanged": true } },
         "serverInfo": { "name": "ai-proxy", "version": "1.0.0", "pageUrl": "https://example.github.io/docs/mcp.html" }
       }
     }
     ```
3. **`notifications/initialized`**:
   - Notification (no `id`) -> **Response**: `202 Accepted` (empty body) or `200 OK` `{"ok":true}`.
4. **`ping`**:
   - **Response (`200 OK`)**: `{"jsonrpc":"2.0","id":2,"result":{}}`

### 2.4 Tab-Forwarded JSON-RPC Methods (`tools/list`, `tools/call`) & ID Rewriting
When multiple MCP clients call the same page concurrently, their JSON-RPC `id` values may collide (e.g., two clients both send `"id": 1`).
- **Relay ID Rewriting**:
  1. `ai-proxy` generates a globally unique `callId` (e.g. `"call_42"`).
  2. In the payload sent to the tab via `/tab/v1/poll`, `rpc.id` is rewritten to `callId`.
  3. When the tab posts `{ sessionId, callId, response }` to `/tab/v1/reply`, `ai-proxy` restores `response.id = originalClientId` before returning the HTTP response to the waiting MCP client.
- **Queue & Timeout Errors**:
  - Per-page pending queue full (default max `32` pending calls): returns `200 OK` with JSON-RPC error `{"code": -32000, "message": "Tab call queue full"}` (or HTTP `429`).
  - No tab connects within timeout or call exceeds execution timeout: returns `200 OK` with JSON-RPC error `{"code": -32001, "message": "Timed out waiting for browser tab"}` (or HTTP `504`).

---

## 3. Browser Tab Endpoints (`/tab/v1/*`)

All `/tab/v1/*` routes (except `/tab/v1/probe`) require the per-page key in `Authorization: Bearer <mcp-key>`.

### 3.1 `POST /tab/v1/hello`
Registers or refreshes a live tab session for a normalized page URL.
- **Headers**: `Authorization: Bearer <mcp-key>`, `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "url": "https://example.github.io/docs/mcp.html",
    "title": "Example Docs MCP",
    "tools": [
      {
        "name": "search_docs",
        "description": "Search documentation",
        "inputSchema": { "type": "object", "properties": { "q": { "type": "string" } }, "required": ["q"] },
        "annotations": { "readOnlyHint": true }
      }
    ]
  }
  ```
- **Responses**:
  - `200 OK`:
    ```json
    {
      "ok": true,
      "sessionId": "ses_9f8e7d6c5b4a",
      "normalizedUrl": "https://example.github.io/docs/mcp.html",
      "pollTimeoutMs": 25000
    }
    ```
  - `401 Unauthorized`: Missing or invalid per-page `mcp-key` for `url`.
  - `403 Forbidden`: `url` is not in the allowlist, or `Origin` does not match `new URL(url).origin`.

### 3.2 `GET /tab/v1/poll?sessionId=<sessionId>`
Long-polls for the next MCP JSON-RPC request destined for this tab.
- **Headers**: `Authorization: Bearer <mcp-key>`
- **Responses**:
  - `200 OK` (call dispatched to tab):
    ```json
    {
      "callId": "call_101",
      "rpc": {
        "jsonrpc": "2.0",
        "id": "call_101",
        "method": "tools/call",
        "params": { "name": "search_docs", "arguments": { "q": "security" } }
      }
    }
    ```
  - `204 No Content`: Long-poll timeout elapsed with no incoming call; tab should poll again.
  - `401 Unauthorized`: Invalid key.
  - `409 Conflict`: `sessionId` is unknown or superseded (e.g. `ai-proxy` restarted). Tab MUST immediately call `POST /tab/v1/hello` to obtain a new `sessionId`.

### 3.3 `POST /tab/v1/ack`
Acknowledges receipt of a `callId` before or during tool execution, extending the call's timeout from connect-timeout to execution-timeout.
- **Request Body**:
  ```json
  { "sessionId": "ses_9f8e7d6c5b4a", "callId": "call_101" }
  ```
- **Responses**:
  - `200 OK`: `{"ok": true}`
  - `404 Not Found`: Unknown `callId`
  - `409 Conflict`: Unknown `sessionId` (re-hello required)

### 3.4 `POST /tab/v1/reply`
Delivers the JSON-RPC response for a `callId`.
- **Request Body**:
  ```json
  {
    "sessionId": "ses_9f8e7d6c5b4a",
    "callId": "call_101",
    "response": {
      "jsonrpc": "2.0",
      "id": "call_101",
      "result": {
        "content": [{ "type": "text", "text": "{\"matches\":[]}" }],
        "isError": false
      }
    }
  }
  ```
- **Responses**:
  - `200 OK`: `{"ok": true}`
  - `404 Not Found`: Unknown or already-completed `callId`
  - `409 Conflict`: Unknown `sessionId`

### 3.5 `POST /tab/v1/tools`
Pushes an updated tool catalog when the tab dynamically registers or unregisters tools.
- **Request Body**:
  ```json
  {
    "sessionId": "ses_9f8e7d6c5b4a",
    "tools": [ ... ]
  }
  ```
- **Responses**: `200 OK` `{"ok": true}`, or `409 Conflict` if `sessionId` expired.

---

## 4. Local Chat Completions for Web Pages (`/v1/*`)

Allows authorized web pages (such as the "Ask AI" sidebar on the documentation site) to query a local model via `claude -p` or a configured OpenAI-compatible upstream.

### 4.1 Origin Authorization & Open-Origin (`*`) Rules
1. Every browser request to `/v1/*` MUST carry an `Origin` header matching either:
   - The built-in dashboard origin (`http://127.0.0.1:<port>` / `http://localhost:<port>`),
   - An origin explicitly added via `ai-proxy allow-origin <origin>`, or
   - Wildcard `*` mode when manually enabled (`ai-proxy allow-origin "*" --ttl <seconds>`).
2. **Tool Filtering Invariant**:
   - Even for explicitly allowed origins, `/v1/chat/completions` ONLY exposes tools that are **both**:
     1. Explicitly named on the CLI/config via `--allow-tool mcp__<server>__<tool>` (individual tool naming; wildcards or whole-server grants are rejected), AND
     2. Annotated with `annotations.readOnlyHint === true`.
   - When wildcard open-origin (`*`) mode is active, **zero tools** are available to `/v1` requests (pure chat only).

### 4.2 `GET /v1/models`
- **Response (`200 OK`)**:
  ```json
  {
    "object": "list",
    "data": [{ "id": "local-default", "object": "model", "owned_by": "ai-proxy" }]
  }
  ```

### 4.3 `POST /v1/chat/completions`
- **Request Body**:
  ```json
  {
    "model": "local-default",
    "messages": [
      { "role": "system", "content": "You are a helpful documentation assistant." },
      { "role": "user", "content": "How does key handoff work?" }
    ],
    "stream": false
  }
  ```
- **Responses**:
  - `200 OK`: Standard OpenAI `chat.completion` JSON object (`id`, `choices[0].message.content`, `usage`).
  - `403 Forbidden`: `Origin` is not allowed on `/v1`.
  - `502 Bad Gateway`: Upstream (`claude -p` or OpenAI endpoint) failed.

---

## 5. Admin & Dashboard Endpoints (`/admin/v1/*`)

All `/admin/v1/*` routes except `POST /admin/v1/open-dashboard` require `Authorization: Bearer <admin-key>`.

### 5.1 `POST /admin/v1/open-dashboard` (Unauthenticated, Origin-Locked, Rate-Limited)
Allows a user visiting the public documentation or unauthenticated dashboard page to ask their local `ai-proxy` to open the authenticated dashboard in a browser tab.
- **Security Checks**:
  1. `Origin` header MUST match one of the registered dashboard origins (e.g. `http://127.0.0.1:<port>`, `http://localhost:<port>`, or the configured public docs site origin). Any other `Origin` receives `403 Forbidden`.
  2. Rate-limited (e.g. max 3 requests per 10 seconds); excess calls receive `429 Too Many Requests`.
  3. Launches the registered dashboard URL with `#admin-key=<adminKey>&mcp-port=<port>` in the system browser.
  4. **Never returns `adminKey` in the HTTP response.**
- **Response (`200 OK`)**:
  ```json
  { "ok": true, "opened": true }
  ```

### 5.2 Authenticated Admin Endpoints (`Authorization: Bearer <admin-key>`)

| Method & Path | Request Body | Response (`200 OK`) | Description |
| :--- | :--- | :--- | :--- |
| `GET /admin/v1/status` | — | `{ ok, port, sites, allowlist, allowedOrigins, openOriginMode, warnings }` | Full relay state, connected tabs, tool counts, and active warnings |
| `GET /admin/v1/sites` | — | `{ sites: [...] }` | List registered sites, connection status, per-page key preview/url, and tools |
| `POST /admin/v1/sites` | `{ url, name?, openTab? }` | `{ ok: true, site: {...} }` | Allow prefix, register site in AI tools (`claude mcp add`), and optionally open tab |
| `DELETE /admin/v1/sites` | `{ url }` | `{ ok: true, removed: url }` | Remove site from AI tools, revoke allowlist prefix, close session, and forget per-page key |
| `POST /admin/v1/allow` | `{ prefix }` | `{ ok: true, allowlist: [...] }` | Add URL prefix to allowlist |
| `POST /admin/v1/deny` | `{ prefix }` | `{ ok: true, allowlist: [...] }` | Remove URL prefix from allowlist and terminate matching tab sessions |
| `POST /admin/v1/origins` | `{ action: "allow"\|"deny", origin, ttlSeconds? }` | `{ ok: true, allowedOrigins, openOriginMode }` | Manage `/v1` allowed origins or toggle temporary open-origin (`*`) chat mode |
| `POST /admin/v1/keys/rotate` | `{ url?: string, rotateAdmin?: boolean }` | `{ ok: true, rotated: [...] }` | Rotate a specific site's key, all site keys, or the admin key |
