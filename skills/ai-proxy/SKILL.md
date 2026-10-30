---
name: ai-proxy
description: Operate, configure, and troubleshoot the local ai-proxy relay for MCP Pages (serve, add, remove, allow, allow-origin, deny, sites, keys rotate, open, doctor, vendor, install --login).
---

# ai-proxy Local Relay Skill (`skills/ai-proxy`)

Use this skill when starting, managing, or troubleshooting the local `ai-proxy` relay (`127.0.0.1:8788`) that connects static **MCP Pages** websites in the browser to local AI tools such as Claude Code.

## 1. Core CLI Commands

Every `ai-proxy` subcommand writes machine-readable JSON to `stdout` and human-readable status messages to `stderr`.

```bash
# Start the local relay (defaults to 127.0.0.1:8788)
npx ai-proxy serve

# Start the relay on a custom port and allow specific read-only tools on /v1
npx ai-proxy serve --port 8788 --allow-tool mcp__notes__search_notes

# Add a static site's MCP page (allows its URL prefix + registers in Claude Code)
npx ai-proxy add https://example.github.io/notes/mcp.html --name notes

# List registered MCP sites and tool counts
npx ai-proxy sites

# Open the authenticated local management dashboard in your browser
npx ai-proxy open dashboard

# Open a specific MCP page in your browser with its #mcp-key fragment
npx ai-proxy open https://example.github.io/notes/mcp.html

# Remove a registered site from ai-proxy and Claude Code
npx ai-proxy remove https://example.github.io/notes/mcp.html

# Manage path-boundary URL prefix allowlist
npx ai-proxy allow https://example.github.io/notes/
npx ai-proxy deny https://example.github.io/notes/

# Manage /v1 chat completions allowed Origins
npx ai-proxy allow-origin https://example.github.io
npx ai-proxy allow-origin '*' --ttl 900
npx ai-proxy deny https://example.github.io --origin

# Rotate per-page or admin keys
npx ai-proxy keys rotate https://example.github.io/notes/mcp.html
npx ai-proxy keys rotate --all
npx ai-proxy keys rotate --admin

# Vendor browser WebMCP modules into a static site and run static checks
npx ai-proxy vendor ./web
npx ai-proxy doctor --dir .

# Install background login service (macOS LaunchAgent or Linux systemd user unit)
npx ai-proxy install --login

# List and install agent skills (skills/ai-proxy, skills/mcp-pages)
npx ai-proxy skills list
npx ai-proxy skills install
npx ai-proxy skills install --target claude
npx ai-proxy skills install --target antigravity
npx ai-proxy skills install --target agents
npx ai-proxy skills install --target cursor

# Initialize or run .devcontainer with host.docker.internal ai-proxy bridge
npx ai-proxy devcontainer init --dir .
npx ai-proxy devcontainer up --dir .
npx ai-proxy devcontainer exec --dir . claude

# Docker-wrapper CLI: run ai-proxy in Docker or wrap "docker run" with host ai-proxy env
npx ai-proxy-docker serve --port 8788
npx ai-proxy-docker run -it my-agent-image claude
npx ai-proxy docker-wrapper --dry-run serve
```

## 2. Security & Operational Rules

1. **Shared Machine / Testing Rule**: When running tests or temporary `ai-proxy` instances on a shared machine, always pass `--port 0` and an isolated `AI_PROXY_HOME` directory. Never kill or occupy port `8788` if another user or service is using it.
2. **Path-Boundary Prefix Matching**: Allowing `https://example.github.io/app/` permits `https://example.github.io/app/mcp.html` but rejects `https://example.github.io/app-other/mcp.html`.
3. **`/v1` Tool Filtering**: `/v1/chat/completions` exposes zero tools by default. To expose a read-only tool to web pages calling `/v1`, pass `--allow-tool mcp__<server>__<tool>` to `ai-proxy serve`. Only tools with `annotations.readOnlyHint === true` will be exposed.
4. **Wildcard `*` on `/v1`**: Running `ai-proxy allow-origin '*' --ttl 900` enables pure-chat mode (zero tools) for 15 minutes and displays a security warning banner on the dashboard and CLI `stderr`.
