---
name: mcp-pages
description: Add a compliant MCP Pages endpoint (mcp.html + vendored WebMCP modules) to any static website or GitHub Pages repository and verify it with ai-proxy doctor.
---

# MCP Pages Authoring Skill (`skills/mcp-pages`)

Use this skill when asked to turn a static website (such as a GitHub Pages repository, documentation site, or static web app) into an **MCP Pages** server so visitors' local AI tools can call client-side WebMCP tools via `ai-proxy`.

## 1. Architecture & Security Rules You Must Follow

1. **Zero Backend Required**: An MCP Page is a static HTML file (`mcp.html` at the site root) that runs in a real visible browser tab and registers tools on `navigator.modelContext`.
2. **Vendor the Browser Modules (`./web/*.mjs`)**: Static sites must vendor the zero-dependency ES modules (`url.mjs`, `handshake.mjs`, `model-context.mjs`, `dispatch.mjs`, `client.mjs`, `ui.mjs`, `index.mjs`) into `./web/` inside the site directory using `ai-proxy vendor`.
3. **Never Store `mcp-key` in Shared Origin Storage**: All sites under `https://<user>.github.io/<repo>/` share a single browser Origin. **Never** write `mcp-key` or `admin-key` to `localStorage`, `sessionStorage`, `IndexedDB`, or `document.cookie`. The vendored `mountMcpPageUi` / `extractHandshake` automatically moves `#mcp-key` from the URL hash into tab-scoped `history.state` and scrubs the URL bar via `history.replaceState`.
4. **Accurate Tool Annotations**:
   - Read-only query/search tools MUST set `annotations: { readOnlyHint: true, destructiveHint: false }`.
   - Tools that create, modify, or delete state MUST set `annotations: { readOnlyHint: false }` (and `destructiveHint: true` if they delete data), and their `description` MUST state that the AI assistant should only invoke them when explicitly requested by the human user.
5. **Support `AbortSignal`**: Tool `execute(input, { signal })` functions should pass `signal` to any `fetch()` calls.

## 2. Step-by-Step Workflow

### Step 1: Vendor the `web/*.mjs` Modules into the Target Site Directory

Run the `ai-proxy vendor` CLI command targeting `./web` inside the static site directory (`<SITE_DIR>`):

```bash
node /path/to/ai-proxy/bin/ai-proxy.mjs vendor <SITE_DIR>/web
# Or if ai-proxy is installed globally / via npx:
npx ai-proxy vendor <SITE_DIR>/web
```

This copies `url.mjs`, `handshake.mjs`, `model-context.mjs`, `dispatch.mjs`, `client.mjs`, `ui.mjs`, and `index.mjs` into `<SITE_DIR>/web/`.

### Step 2: Create `<SITE_DIR>/mcp.html`

Create `mcp.html` in `<SITE_DIR>` that imports `mountMcpPageUi` from `./web/ui.mjs` (or `./web/index.mjs`) and mounts your site's tools into a visible container:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>Site MCP Page</title>
</head>
<body>
  <main>
    <h1>Site MCP Page</h1>
    <div id="mcp-catalog"></div>
  </main>

  <script type="module">
    import { mountMcpPageUi } from './web/ui.mjs';

    const tools = [
      {
        name: 'search_items',
        description: 'Search items on this static site by keyword.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search keyword'
            }
          },
          required: ['query'],
          additionalProperties: false
        },
        annotations: {
          title: 'Search Items',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        },
        async execute({ query }, { signal } = {}) {
          // Read from static JSON, DOM, or local state
          return {
            query,
            matches: []
          };
        }
      }
    ];

    mountMcpPageUi({
      container: document.getElementById('mcp-catalog'),
      title: 'Site WebMCP Tools',
      tools
    });
  </script>
</body>
</html>
```

### Step 3: Link to `mcp.html` and Add Connect Badge

Add a visible link `<a href="mcp.html">MCP Page</a>` and the registration command (`npx ai-proxy add https://example.github.io/<repo>/mcp.html`) to the site's main page so readers and AI tools can discover it.

In your project's `README.md`, add the standard **MCP Pages: Connect** badge:

```markdown
[![MCP Pages: Connect](https://img.shields.io/badge/MCP%20Pages-Connect-238636?logo=github&logoColor=white)](https://yongjhih.github.io/ai-proxy/dashboard.html#add-url=https%3A%2F%2F<user>.github.io%2F<repo>%2Fmcp)
```

Clicking the badge opens the `ai-proxy` dashboard with `#add-url=...`, probes the local relay (port 8788), and pre-populates the site URL.

In your site's Ask AI drawer / chat assistant, when users ask about MCP or ai-proxy, offer an interactive one-click CTA button:

```markdown
[➕ 一鍵新增到 local ai-proxy](action:add-mcp?url=https://<user>.github.io/<repo>/mcp)
```

### Step 4: Verify with `ai-proxy doctor`

Always run `ai-proxy doctor --dir <SITE_DIR>` and verify it exits with code `0` (`"ok": true`):

```bash
node /path/to/ai-proxy/bin/ai-proxy.mjs doctor --dir <SITE_DIR>
```

All three checks (`mcp_page_exists`, `vendored_web_modules`, and `mcp_page_wiring`) must report `"ok": true`.
