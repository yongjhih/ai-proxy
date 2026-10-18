# ai-proxy · MCP Pages Reference Relay & Specification

[![Coverage](https://yongjhih.github.io/ai-proxy/covpages/badge.svg)](https://yongjhih.github.io/ai-proxy/covpages/)
[![Specification](https://img.shields.io/badge/docs-specification-blue.svg)](https://yongjhih.github.io/ai-proxy/doc?d=spec)
[![Security](https://img.shields.io/badge/security-7%20baselines-success.svg)](https://yongjhih.github.io/ai-proxy/doc?d=security)
[![Devcontainer](https://img.shields.io/badge/devcontainer-ready-blue.svg)](.devcontainer/devcontainer.json)
[![Docker](https://img.shields.io/badge/docker-wrapper-informational.svg)](bin/ai-proxy-docker.mjs)

[English](./README.md) | [繁體中文](./README.zh-TW.md) · 🌐 **Website**: [https://yongjhih.github.io/ai-proxy/](https://yongjhih.github.io/ai-proxy/) · 📊 **Coverage Report**: [https://yongjhih.github.io/ai-proxy/covpages/](https://yongjhih.github.io/ai-proxy/covpages/)

**MCP Pages** is an open specification that turns any static website (such as GitHub Pages) into a client-side [WebMCP](https://webmachinelearning.github.io/webmcp/) tool server—without running a backend.

**`ai-proxy`** is the zero-dependency Node.js reference relay that runs on the reader's machine (`127.0.0.1:8788`), bridging local AI assistants (Claude Code, Cursor, MCP stdio/HTTP clients) to browser tabs running static MCP Pages.

## Architecture

```
AI Tool (Claude Code / MCP Client)
  │
  │  Streamable HTTP POST /mcp?url=https://example.github.io/docs/mcp.html
  ▼
ai-proxy (127.0.0.1:8788)
  │
  │  Long Polling (/tab/v1/hello, /tab/v1/poll, /tab/v1/ack, /tab/v1/reply)
  ▼
Browser Tab (https://example.github.io/docs/mcp.html running navigator.modelContext)
```

- **Browser Modules (`web/*.mjs`)**: Zero-dependency ES modules vendored into static sites (`url.mjs`, `handshake.mjs`, `model-context.mjs`, `dispatch.mjs`, `client.mjs`, `ui.mjs`, `index.mjs`).
- **Local Relay (`src/*.mjs`)**: Zero-dependency Node.js HTTP server providing `/mcp` (Streamable HTTP JSON-RPC 2.0), `/tab/v1/*` (browser tab long-polling transport), `/v1` (OpenAI-compatible chat completions with strict per-tool read-only filtering), and `/admin/v1/*` (local dashboard management API).
- **Static Site & Dashboard (`index.html`, `zh-TW.html`, `doc.html`, `dashboard.html`, `mcp.html`)**: GitHub Primer-styled documentation site, SPA Markdown reader, relay management dashboard, and built-in MCP Page (`about`, `sites`, `site_tools`, `spec`, `add_site`, `remove_site`).

## Quick Start

```bash
# 1. Start the local ai-proxy relay (listens on 127.0.0.1:8788)
npx ai-proxy serve

# 2. Register and allow this site's MCP page in Claude Code
npx ai-proxy add https://yongjhih.github.io/ai-proxy/mcp --name ai-proxy

# 3. Open the authenticated local management dashboard
npx ai-proxy open dashboard
```

## Authoring an MCP Page for Your Static Site

```bash
# 1. Vendor the zero-dependency WebMCP modules into your static site
npx ai-proxy vendor ./web

# 2. Create mcp.html (or ask an AI agent with skills/mcp-pages/SKILL.md)
# 3. Verify your static site passes all MCP Pages checks
npx ai-proxy doctor --dir .
```

See [`examples/notes-site/`](./examples/notes-site/) for a complete working example.

## Seven Security Baselines for Shared Origins (`<user>.github.io`)

All repositories under `https://<user>.github.io/<repo>/` share **one browser Origin**. `ai-proxy` enforces seven mandatory baselines documented in [`docs/security.md`](./docs/security.md) and tested in [`test/security-baselines.test.mjs`](./test/security-baselines.test.mjs):

1. **Rule 1 (Path-Boundary URL Prefix Allowlist)**: Matches normalized URL prefixes at path segment boundaries (`https://example.github.io/docs/` never matches `https://example.github.io/docs-evil/`). `localhost` / `127.0.0.1` are always allowed.
2. **Rule 2 (Per-Page Key in URL Fragment -> `history.state`)**: Keys are delivered via `#mcp-key=...&mcp-port=...`, immediately moved into tab-scoped `history.state`, scrubbed from the URL bar via `history.replaceState`, and never written to `localStorage`, `sessionStorage`, `IndexedDB`, or cookies.
3. **Rule 3 (`/mcp` Rejects Browser `Origin` Headers)**: Any `POST /mcp` carrying an `Origin` header is rejected with `403 Forbidden`.
4. **Rule 4 (`/v1` Explicit Per-Tool Read-Only Filtering)**: `/v1/chat/completions` exposes zero tools by default; only tools explicitly named via `--allow-tool mcp__<server>__<tool>` that also declare `annotations.readOnlyHint === true` can be called.
5. **Rule 5 (Separate Admin Key & Safe `open-dashboard` Handoff)**: `/admin/v1/*` uses a separate `adminKey`. The only unauthenticated route (`POST /admin/v1/open-dashboard`) verifies the dashboard `Origin`, opens a browser tab locally, never returns any key in the HTTP response body, and is rate-limited.
6. **Rule 6 (Mutating Tools Require Explicit User Intent)**: Tools that modify state (`add_site`, `remove_site`) declare `readOnlyHint: false` so AI clients prompt the human user before execution.
7. **Rule 7 (Wildcard `*` on `/v1` is Pure Chat with TTL & Warnings)**: Allowing `*` on `/v1` forces zero tools, sets a 15-minute TTL by default, and displays prominent warnings across the dashboard and CLI `stderr`.

## Normative Specifications

- [Overview & Architecture (`docs/index.md`)](./docs/index.md) · [繁體中文 (`docs/zh-TW/index.md`)](./docs/zh-TW/index.md)
- [MCP Pages Specification (`docs/spec.md`)](./docs/spec.md) · [繁體中文 (`docs/zh-TW/spec.md`)](./docs/zh-TW/spec.md)
- [Relay Wire Protocol (`docs/protocol.md`)](./docs/protocol.md) · [繁體中文 (`docs/zh-TW/protocol.md`)](./docs/zh-TW/protocol.md)
- [Security Model & Threat Analysis (`docs/security.md`)](./docs/security.md) · [繁體中文 (`docs/zh-TW/security.md`)](./docs/zh-TW/security.md)

## Agent Skills

- [`skills/mcp-pages/SKILL.md`](./skills/mcp-pages/SKILL.md): Instructions for AI coding agents to add a compliant MCP Page (`mcp.html` + `web/*.mjs`) to any static site.
- [`skills/ai-proxy/SKILL.md`](./skills/ai-proxy/SKILL.md): Instructions for AI coding agents to operate and manage `ai-proxy`.

## Devcontainer & Docker Wrapper CLI

### 1. `.devcontainer` Support (`ai-proxy devcontainer`)

This repository includes a ready-to-use [`.devcontainer/devcontainer.json`](./.devcontainer/devcontainer.json) and [`.devcontainer/Dockerfile`](./.devcontainer/Dockerfile) that forwards port `8788`, maps `host.docker.internal`, and sets `AI_PROXY_HOST=host.docker.internal` so AI tools running inside a Dev Container or Codespace can talk to your host browser's `ai-proxy` relay.

You can also initialize or run `.devcontainer` in any project via the CLI:

```bash
# Generate or merge .devcontainer/devcontainer.json in any project
npx ai-proxy devcontainer init --dir .

# Launch or exec into a devcontainer with ai-proxy environment variables wired
npx ai-proxy devcontainer up --dir .
npx ai-proxy devcontainer exec --dir . claude
```

### 2. `docker-wrapper` CLI (`ai-proxy-docker` / `docker-wrapper` / `ai-proxy docker`)

```bash
# Mode A: Run ai-proxy inside Docker (builds ai-proxy:local automatically if needed)
npx ai-proxy-docker serve --port 8788
npx ai-proxy-docker add https://yongjhih.github.io/ai-proxy/mcp --name ai-proxy
npx ai-proxy-docker doctor --dir .

# Mode B: Wrap "docker run" so containerized AI tools (e.g. Claude Code) connect to host ai-proxy
npx ai-proxy-docker run -it my-agent-image claude
# Or via the main CLI:
npx ai-proxy docker-wrapper run -it my-agent-image claude
```

## Running Tests

Zero npm dependencies are required. Run the full unit, integration, security baseline, devcontainer/docker-wrapper, and headless browser E2E test suite with Node.js (`>=22`):

```bash
npm test
```

## License

[MIT](./LICENSE)
