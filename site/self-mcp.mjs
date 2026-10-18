/**
 * Built-in MCP Page for ai-proxy & MCP Pages documentation site (mcp.html).
 * Exposes `about`, `sites`, `site_tools`, `spec`, `add_site`, `remove_site`.
 * When opened with `#admin-key=...`, mounts the inline management dashboard below the tool catalog.
 */

import { extractHandshake } from '../web/handshake.mjs';
import { mountMcpPageUi } from '../web/ui.mjs';
import { getRuntimeSiteBaseUrl, replaceBaseUrlPlaceholder } from './doc-reader.mjs';
import { mountAdminDashboard } from './dashboard.mjs';

export async function initSelfMcpPage({
  catalogContainer,
  adminContainer,
  win = globalThis.window,
  importMetaUrl = import.meta.url
} = {}) {
  const hs = extractHandshake(win);
  const siteBaseUrl = getRuntimeSiteBaseUrl(importMetaUrl, win);
  const urlPort = win && win.location && win.location.port ? Number.parseInt(win.location.port, 10) : 0;
  const mcpPort = hs.mcpPort !== 8788 ? hs.mcpPort : urlPort || 8788;
  const relayBaseUrl = `http://127.0.0.1:${mcpPort}`;

  async function fetchAdminJson(path, init = {}) {
    if (!hs.adminKey) {
      throw new Error(
        'This action requires an admin-key in history.state. Open this page via "ai-proxy open dashboard" or connect from the dashboard first.'
      );
    }
    const res = await fetch(`${relayBaseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hs.adminKey}`,
        ...(init.headers || {})
      }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  async function executeAddSite({
    url,
    name,
    write = true,
    allowOrigin = true,
    allowPrefix = true
  }) {
    const res = await fetchAdminJson('/admin/v1/sites', {
      method: 'POST',
      body: JSON.stringify({
        url,
        name,
        write: write !== false,
        allowOrigin: allowOrigin !== false,
        allowPrefix: allowPrefix !== false
      })
    });
    if (adminCtrl) {
      await adminCtrl.refreshDashboard();
    }
    if (win && typeof win.dispatchEvent === 'function') {
      try {
        win.dispatchEvent(new win.CustomEvent('ai-proxy-refresh-dashboard'));
      } catch {}
    }
    return {
      ok: true,
      site: res.site
    };
  }

  async function executeSetSitePermission({ url, write }) {
    const res = await fetchAdminJson('/admin/v1/sites/permission', {
      method: 'POST',
      body: JSON.stringify({ url, write: Boolean(write) })
    });
    if (adminCtrl) {
      await adminCtrl.refreshDashboard();
    }
    if (win && typeof win.dispatchEvent === 'function') {
      try {
        win.dispatchEvent(new win.CustomEvent('ai-proxy-refresh-dashboard'));
      } catch {}
    }
    return {
      ok: true,
      site: res.site
    };
  }

  async function executeRemoveSite({ url }) {
    const res = await fetchAdminJson('/admin/v1/sites', {
      method: 'DELETE',
      body: JSON.stringify({ url })
    });
    if (adminCtrl) {
      await adminCtrl.refreshDashboard();
    }
    if (win && typeof win.dispatchEvent === 'function') {
      try {
        win.dispatchEvent(new win.CustomEvent('ai-proxy-refresh-dashboard'));
      } catch {}
    }
    return {
      ok: true,
      removed: res.removed
    };
  }

  async function executeAllowOrigin({ origin, ttlSeconds }) {
    const res = await fetchAdminJson('/admin/v1/origins', {
      method: 'POST',
      body: JSON.stringify({ origin, action: 'allow', ttlSeconds })
    });
    if (adminCtrl) {
      await adminCtrl.refreshDashboard();
    }
    if (win && typeof win.dispatchEvent === 'function') {
      try {
        win.dispatchEvent(new win.CustomEvent('ai-proxy-refresh-dashboard'));
      } catch {}
    }
    return {
      ok: true,
      allowedOrigins: res.allowedOrigins,
      openOriginMode: res.openOriginMode,
      warnings: res.warnings
    };
  }

  async function executeDenyOrigin({ origin }) {
    const res = await fetchAdminJson('/admin/v1/origins', {
      method: 'POST',
      body: JSON.stringify({ origin, action: 'deny' })
    });
    if (adminCtrl) {
      await adminCtrl.refreshDashboard();
    }
    if (win && typeof win.dispatchEvent === 'function') {
      try {
        win.dispatchEvent(new win.CustomEvent('ai-proxy-refresh-dashboard'));
      } catch {}
    }
    return {
      ok: true,
      allowedOrigins: res.allowedOrigins
    };
  }

  async function executeAllowPrefix({ prefix }) {
    const res = await fetchAdminJson('/admin/v1/allow', {
      method: 'POST',
      body: JSON.stringify({ prefix })
    });
    if (adminCtrl) {
      await adminCtrl.refreshDashboard();
    }
    if (win && typeof win.dispatchEvent === 'function') {
      try {
        win.dispatchEvent(new win.CustomEvent('ai-proxy-refresh-dashboard'));
      } catch {}
    }
    return {
      ok: true,
      allowlist: res.allowlist
    };
  }

  async function executeDenyPrefix({ prefix }) {
    const res = await fetchAdminJson('/admin/v1/deny', {
      method: 'POST',
      body: JSON.stringify({ prefix })
    });
    if (adminCtrl) {
      await adminCtrl.refreshDashboard();
    }
    if (win && typeof win.dispatchEvent === 'function') {
      try {
        win.dispatchEvent(new win.CustomEvent('ai-proxy-refresh-dashboard'));
      } catch {}
    }
    return {
      ok: true,
      allowlist: res.allowlist
    };
  }

  const tools = [
    {
      name: 'about',
      description:
        'Return an overview of the MCP Pages specification, the ai-proxy local relay architecture, and available documentation topics.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      annotations: {
        title: 'About MCP Pages & ai-proxy',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      async execute() {
        return {
          name: 'ai-proxy',
          specification: 'MCP Pages 1.0',
          siteBaseUrl,
          relayPort: mcpPort,
          adminAuthenticated: Boolean(hs.adminKey),
          docs: ['index', 'spec', 'protocol', 'security'],
          summary:
            'MCP Pages enables any static website (such as GitHub Pages) to expose client-side WebMCP tools to local AI assistants via the zero-dependency ai-proxy relay.'
        };
      }
    },
    {
      name: 'sites',
      description:
        'List MCP Pages sites currently registered in the local ai-proxy relay, including connection state and tool counts.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      annotations: {
        title: 'List Registered Sites',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      async execute() {
        if (!hs.adminKey) {
          return {
            authenticated: false,
            sites: [
              {
                name: 'ai-proxy-self',
                url: `${siteBaseUrl}mcp`,
                note: 'Open with admin-key to list all sites registered in local ai-proxy.'
              }
            ]
          };
        }
        const data = await fetchAdminJson('/admin/v1/sites');
        return {
          authenticated: true,
          sites: data.sites
        };
      }
    },
    {
      name: 'site_tools',
      description:
        'List the WebMCP tools registered for a specific site URL (or this site if url is omitted).',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Optional normalized page URL of the registered site'
          }
        },
        additionalProperties: false
      },
      annotations: {
        title: 'Inspect Site Tools',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      async execute({ url }) {
        if (!url || url === `${siteBaseUrl}mcp.html` || url === `${siteBaseUrl}mcp`) {
          const selfTools =
            win && win.navigator && win.navigator.modelContext
              ? win.navigator.modelContext.listTools()
              : [];
          return {
            url: `${siteBaseUrl}mcp`,
            tools: selfTools
          };
        }
        const data = await fetchAdminJson('/admin/v1/sites');
        const found = (data.sites || []).find(
          (s) => s.url === url || s.name === url || s.url === `${url}.html` || `${s.url}.html` === url
        );
        if (!found) {
          throw new Error(`Site not found: ${url}`);
        }
        return {
          url: found.url,
          name: found.name,
          connected: found.connected,
          tools: found.tools || []
        };
      }
    },
    {
      name: 'spec',
      description:
        'Read the normative MCP Pages documentation (spec, protocol, security, or index) in English or Traditional Chinese (zh-TW).',
      inputSchema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            enum: ['index', 'spec', 'protocol', 'security'],
            description: 'Documentation topic to retrieve (index, spec, protocol, or security)'
          },
          lang: {
            type: 'string',
            enum: ['en', 'zh-TW'],
            description: 'Language code (en or zh-TW)'
          }
        },
        additionalProperties: false
      },
      annotations: {
        title: 'Read Normative Specification',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      async execute({ topic = 'spec', lang = 'en' }, { signal } = {}) {
        const prefix = lang === 'zh-TW' ? 'docs/zh-TW/' : 'docs/';
        const docUrl = new URL(`${prefix}${topic}.md`, siteBaseUrl).href;
        const res = await fetch(docUrl, { signal });
        if (!res.ok) {
          throw new Error(`Failed to load ${docUrl} (HTTP ${res.status})`);
        }
        const raw = await res.text();
        return {
          topic,
          lang,
          markdown: replaceBaseUrlPlaceholder(raw, siteBaseUrl)
        };
      }
    },
    {
      name: 'knowledge',
      description:
        'Query comprehensive ai-proxy & MCP Pages knowledge: architecture, 7 security baselines, specifications, protocol, FAQ, and WebMCP standards in English or Traditional Chinese.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            enum: ['all', 'overview', 'architecture', 'security', 'spec', 'protocol', 'faq', 'quickstart', 'webmcp'],
            description: 'Topic to retrieve (all, overview, architecture, security, spec, protocol, faq, quickstart, webmcp)'
          },
          query: {
            type: 'string',
            description: 'Optional keyword or phrase to filter sections'
          },
          lang: {
            type: 'string',
            enum: ['en', 'zh-TW'],
            description: 'Language code (en or zh-TW)'
          }
        },
        additionalProperties: false
      },
      annotations: {
        title: 'Query ai-proxy Knowledge',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      async execute({ topic = 'all', query = '', lang = 'zh-TW' } = {}) {
        const isZh = lang === 'zh-TW';
        const knowledgeData = {
          overview: {
            title: isZh ? 'ai-proxy 概述' : 'ai-proxy Overview',
            summary: isZh
              ? 'ai-proxy 是一個零依賴（Zero-Dependency）的輕量級本機中繼器，允許任何靜態網站（如 GitHub Pages）透過標準 WebMCP 協定，向本機 AI 助理（Claude Code、Antigravity、Cursor、Windsurf）安全暴露工具。'
              : 'ai-proxy is a lightweight, zero-dependency local relay that allows any static website (such as GitHub Pages) to securely expose client-side WebMCP tools to local AI assistants.'
          },
          architecture: {
            title: isZh ? '系統架構' : 'System Architecture',
            summary: isZh
              ? '本機 Relay (http://127.0.0.1:8788) 作為 MCP Client (Claude Code) 與瀏覽器分頁 (WebMCP Tab) 間的雙向通道。分頁透過 Long Polling (/tab/v1/poll) 保持長輪詢，Relay 自動執行多客戶端 ID 重寫、超時控管與閒置喚醒。'
              : 'The local relay (http://127.0.0.1:8788) bridges MCP clients (Claude Code) and browser tabs (WebMCP tabs). Tabs maintain long-polling (/tab/v1/poll), and the relay manages multi-client JSON-RPC ID rewriting, queue limits, and idle tab wakeups.',
            components: [
              { name: 'Relay Server', port: mcpPort, role: 'JSON-RPC 2.0 router and HTTP server' },
              { name: 'Tab Connection', endpoint: '/tab/v1/*', role: 'Hello, long polling, ack, reply, and tool sync' },
              { name: 'Claude Code MCP', endpoint: '/mcp', role: 'HTTP MCP endpoint for external AI coding tools' },
              { name: 'Ask AI Chat', endpoint: '/v1/chat/completions', role: 'Local OpenAI-compatible completions API' },
              { name: 'Dashboard SPA', endpoint: '/dashboard.html', role: 'Site management and allowlist inspection' }
            ]
          },
          security: {
            title: isZh ? '七大安全基準 (7 Security Baselines)' : '7 Security Baselines',
            baselines: [
              {
                rule: 1,
                name: isZh ? 'Fragment 金鑰隔離' : 'Fragment Key Isolation',
                desc: isZh
                  ? 'mcp-key 僅經由 URL Fragment (#mcp-key=...) 傳遞，頁面載入後立即轉存入 tab-scoped history.state 並清除網址列，嚴禁寫入 localStorage、sessionStorage 或 Cookie。'
                  : 'mcp-key is transmitted solely via URL fragment (#mcp-key=...), immediately moved into tab-scoped history.state, and never stored in localStorage, sessionStorage, or cookies.'
              },
              {
                rule: 2,
                name: isZh ? 'URL Prefix 白名單' : 'URL Prefix Allowlist',
                desc: isZh
                  ? '嚴格遵循路徑邊界（如 https://user.github.io/repo/），阻絕同源兄弟儲存庫（Sibling Repos）未授權連線。'
                  : 'Strict path-boundary checking prevents unauthorized sibling repositories under the same domain (e.g. *.github.io).'
              },
              {
                rule: 3,
                name: isZh ? '封鎖 /mcp 的 Origin 標頭' : 'Block Origin Header on /mcp',
                desc: isZh
                  ? '/mcp 端點拒絕任何攜帶 Origin 標頭的請求（403 Forbidden），防範網頁偽裝成 MCP Client。'
                  : '/mcp rejects any request with an Origin header (403 Forbidden), preventing web pages from acting as MCP clients.'
              },
              {
                rule: 4,
                name: isZh ? '/v1 僅限具名唯讀工具' : '/v1 Exposes Only Named Read-Only Tools',
                desc: isZh
                  ? '網頁調用 /v1 聊天端點時，僅允許 annotations.readOnlyHint === true 且由 --allow-tool 個別具名授權之工具，全面防禦間接提示詞注入（Indirect Prompt Injection）。'
                  : '/v1 only exposes tools where annotations.readOnlyHint === true AND explicitly granted via --allow-tool, preventing indirect prompt injection.'
              },
              {
                rule: 5,
                name: isZh ? '獨立 Admin Key 與 Origin 鎖定' : 'Isolated Admin Key & Origin Lock',
                desc: isZh
                  ? '管理操作使用獨立 admin-key；唯一公開端點 POST /admin/v1/open-dashboard 具 Origin 驗證與嚴格速率限制（429），且絕不返回金鑰。'
                  : 'Admin API uses a distinct admin-key; POST /admin/v1/open-dashboard is strictly origin-checked, rate-limited, and never leaks the key.'
              },
              {
                rule: 6,
                name: isZh ? '異動型工具非唯讀標記與防呆' : 'Mutating Tools Guardrail',
                desc: isZh
                  ? '修改狀態之工具（如 add_mcp, remove_mcp）必須標記 readOnlyHint: false，且說明必須明確要求使用者主動指示。'
                  : 'State-mutating tools must set readOnlyHint: false and document explicit human intent requirements.'
              },
              {
                rule: 7,
                name: isZh ? '萬用字元 Origin 純對話且時效限制' : 'Wildcard Origin Pure Chat & TTL',
                desc: isZh
                  ? '啟用 allow-origin * 時強制關閉所有 /v1 工具（純文字對話），支援 --ttl 逾時自動復原並在 healthz 發出醒目告警。'
                  : 'Wildcard origin (*) forces zero tools on /v1 (pure chat only), supports TTL expiration, and emits prominent warnings.'
              }
            ]
          },
          spec: {
            title: isZh ? 'WebMCP 規格與標準' : 'WebMCP Specification',
            summary: isZh
              ? 'WebMCP 標準基於 window.navigator.modelContext，提供 registerTool、listTools、callTool 等標準 API。每個工具包含 name, description, inputSchema (JSON Schema), annotations (readOnlyHint, destructiveHint, idempotentHint)。'
              : 'WebMCP standard extends window.navigator.modelContext with registerTool, listTools, and callTool. Tools include name, description, inputSchema, and annotations.'
          },
          protocol: {
            title: isZh ? '傳輸協定 (Protocol)' : 'Transport Protocol',
            summary: isZh
              ? '透過 Long Polling 實現全雙工互動。連線流程：1. POST /tab/v1/hello 註冊 tools 並獲取 sessionId；2. GET /tab/v1/poll 長輪詢等待 RPC 調用；3. POST /tab/v1/ack 確認收到；4. POST /tab/v1/reply 回報 JSON-RPC 2.0 結果。若收到 409 Conflict，分頁以原本金鑰自動重新 hello。'
              : 'Long polling enables bidirectional communication: 1. POST /tab/v1/hello registers tools; 2. GET /tab/v1/poll waits for incoming RPC; 3. POST /tab/v1/ack acknowledges; 4. POST /tab/v1/reply returns JSON-RPC 2.0 results. 409 Conflict triggers transparent re-hello.'
          },
          faq: {
            title: isZh ? '常見問題 (FAQ)' : 'Frequently Asked Questions',
            items: [
              {
                q: isZh ? '為什麼選擇靜態網站 (GitHub Pages) 作為 MCP Server？' : 'Why use static sites (GitHub Pages) as MCP servers?',
                a: isZh
                  ? '靜態網站零伺服器維護成本、部署於 GitHub Pages / Cloudflare Pages / S3 極速穩定。透過本機 ai-proxy，瀏覽器客戶端 JavaScript 的即時狀態、DOM 或 Client-side 運算可無縫化身為 AI 工具。'
                  : 'Static sites have zero server overhead, deploy globally for free, and allow client-side JavaScript, DOM state, and Web APIs to become local AI tools seamlessly.'
              },
              {
                q: isZh ? 'ai-proxy 需要額外後端伺服器嗎？' : 'Does ai-proxy require an external backend?',
                a: isZh
                  ? '完全不需要。ai-proxy 採本機 Node.js 原生模組開發，零外部 npm 依賴（Zero Dependencies），只在 127.0.0.1 本機運作。'
                  : 'No. ai-proxy is completely local and built with pure Node.js standard library without third-party dependencies.'
              },
              {
                q: isZh ? '如何防止跨站腳本或惡意網頁存取本機？' : 'How does ai-proxy prevent cross-site attacks?',
                a: isZh
                  ? '結合 URL Prefix 白名單、隨機 per-page 金鑰隔離、/mcp 端點 Origin 檢查、以及 /v1 唯讀保護，惡意網頁既無法呼叫 /mcp，也無法假冒已授權站點。'
                  : 'Through URL prefix allowlists, per-page token isolation, /mcp origin blocking, and /v1 read-only restrictions.'
              }
            ]
          },
          quickstart: {
            title: isZh ? '快速開始 (Quickstart)' : 'Quickstart Guide',
            steps: [
              '1. 啟動本機 relay: npx ai-proxy serve',
              '2. 新增站點: npx ai-proxy add https://yongjhih.github.io/ai-proxy/mcp --name ai-proxy',
              '3. 連接 Claude Code: claude mcp add --transport http ai-proxy http://127.0.0.1:8788/mcp?url=https://yongjhih.github.io/ai-proxy/mcp',
              '4. 開啟管理儀表板: npx ai-proxy open dashboard'
            ]
          }
        };

        if (topic !== 'all' && knowledgeData[topic]) {
          return {
            topic,
            lang,
            data: knowledgeData[topic]
          };
        }

        if (query) {
          const q = query.toLowerCase();
          const filtered = {};
          for (const [k, v] of Object.entries(knowledgeData)) {
            const str = JSON.stringify(v).toLowerCase();
            if (str.includes(q)) {
              filtered[k] = v;
            }
          }
          return {
            query,
            lang,
            topics: Object.keys(filtered),
            results: filtered
          };
        }

        return {
          topic: 'all',
          lang,
          topics: Object.keys(knowledgeData),
          knowledge: knowledgeData
        };
      }
    },
    {
      name: 'cli_skills',
      description:
        'Get installation and usage instructions for the ai-proxy CLI, Claude Code integration, and AI agent skills (skills/mcp-pages/SKILL.md).',
      inputSchema: {
        type: 'object',
        properties: {
          client: {
            type: 'string',
            enum: ['all', 'cli', 'claude_code', 'skills', 'antigravity', 'cursor', 'windsurf'],
            description: 'Target client or component (cli, claude_code, skills, antigravity, cursor, windsurf, or all)'
          },
          lang: {
            type: 'string',
            enum: ['en', 'zh-TW'],
            description: 'Language code (en or zh-TW)'
          }
        },
        additionalProperties: false
      },
      annotations: {
        title: 'CLI & Skills Installation Guide',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      async execute({ client = 'all', lang = 'zh-TW' } = {}) {
        const isZh = lang === 'zh-TW';
        const guide = {
          cli: {
            name: 'ai-proxy CLI',
            install: {
              npx: 'npx ai-proxy serve --port 8788',
              global: 'npm install -g @ai-proxy/cli'
            },
            commands: [
              { cmd: 'ai-proxy serve [--port 8788] [--allow-tool ...]', desc: isZh ? '啟動本機中繼器' : 'Start local relay server' },
              { cmd: 'ai-proxy add <url> [--name <slug>] [--read-only]', desc: isZh ? '新增並允許 MCP 站點' : 'Add and allow MCP site' },
              { cmd: 'ai-proxy remove <url_or_name>', desc: isZh ? '移除 MCP 站點' : 'Remove MCP site' },
              { cmd: 'ai-proxy allow <prefix>', desc: isZh ? '將 URL 前綴加入白名單' : 'Allow URL prefix' },
              { cmd: 'ai-proxy allow-origin <origin|*> [--ttl <sec>]', desc: isZh ? '允許 /v1 的 Origin 或啟用純對話模式' : 'Allow Origin for /v1 or enable wildcard pure-chat' },
              { cmd: 'ai-proxy deny <prefix_or_origin>', desc: isZh ? '撤銷 URL 前綴或 Origin' : 'Revoke prefix or origin' },
              { cmd: 'ai-proxy open [dashboard|<url>]', desc: isZh ? '以安全金鑰在瀏覽器開啟控制台或 MCP 頁面' : 'Open dashboard or MCP page in browser with key' },
              { cmd: 'ai-proxy vendor <dir>', desc: isZh ? '複製前端 WebMCP 模組 (web/*.mjs) 至專案目錄' : 'Vendor WebMCP client modules into target directory' },
              { cmd: 'ai-proxy doctor [--dir <dir>]', desc: isZh ? '診斷靜態站點之 MCP 設定與安全合規性' : 'Diagnose site MCP configuration and security compliance' },
              { cmd: 'ai-proxy install --login', desc: isZh ? '安裝為作業系統開機啟動服務 (Launchd / Systemd)' : 'Install as OS login background service (Launchd / Systemd)' },
              { cmd: 'ai-proxy docker [run|serve|...]', desc: isZh ? '以容器化環境執行 ai-proxy' : 'Run ai-proxy inside Docker container' }
            ]
          },
          claude_code: {
            name: 'Claude Code Integration',
            command: 'claude mcp add --transport http ai-proxy http://127.0.0.1:8788/mcp?url=https://yongjhih.github.io/ai-proxy/mcp',
            notes: isZh
              ? '若新增多個站點，可重複執行 claude mcp add 指向不同站點的 URL，或直接於 ai-proxy dashboard 新增，ai-proxy 會自動註冊至 Claude Code 設定。'
              : 'You can register multiple sites by executing claude mcp add for each site, or use the ai-proxy dashboard which auto-registers with Claude Code.'
          },
          skills: {
            name: 'MCP Pages Agent Skill (skills/mcp-pages/SKILL.md)',
            file: 'skills/mcp-pages/SKILL.md',
            description: isZh
              ? '提供給 AI Coding Assistant (Antigravity, Cursor, Windsurf) 的技能定義檔，教導 AI 如何為現有靜態網頁自動建立 mcp.html 與暴露 WebMCP 工具。'
              : 'Skill definition file for AI coding assistants (Antigravity, Cursor, Windsurf) guiding agents to author static MCP pages with vendored WebMCP modules.',
            targets: {
              antigravity: {
                location: '~/.gemini/skills/mcp-pages/SKILL.md 或專案 .gemini/skills/mcp-pages/SKILL.md',
                how: '複製專案 skills/mcp-pages/ 到 ~/.gemini/skills/mcp-pages/ 目錄。'
              },
              cursor: {
                location: '.cursor/skills/mcp-pages/SKILL.md 或 .cursorrules',
                how: '將 skills/mcp-pages/SKILL.md 內容引用或放置於 .cursor/skills/mcp-pages/。'
              },
              windsurf: {
                location: '.windsurf/skills/mcp-pages/SKILL.md',
                how: '複製 skills/mcp-pages/SKILL.md 至專案 .windsurf/skills/mcp-pages/。'
              }
            }
          }
        };

        if (client === 'cli') return { client, lang, guide: guide.cli };
        if (client === 'claude_code') return { client, lang, guide: guide.claude_code };
        if (client === 'skills') return { client, lang, guide: guide.skills };
        if (client === 'antigravity') return { client, lang, guide: guide.skills.targets.antigravity };
        if (client === 'cursor') return { client, lang, guide: guide.skills.targets.cursor };
        if (client === 'windsurf') return { client, lang, guide: guide.skills.targets.windsurf };

        return {
          client: 'all',
          lang,
          guide
        };
      }
    },
    {
      name: 'site_tour',
      description:
        'Explore ai-proxy website pages, structure, interactive anchors, and navigation shortcuts.',
      inputSchema: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            description: 'Optional section or page identifier (e.g. home, zh-TW, doc, dashboard, mcp, quickstart, security)'
          },
          lang: {
            type: 'string',
            enum: ['en', 'zh-TW'],
            description: 'Language code (en or zh-TW)'
          }
        },
        additionalProperties: false
      },
      annotations: {
        title: 'ai-proxy Site Tour & Navigation',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      async execute({ section = '', lang = 'zh-TW' } = {}) {
        const isZh = lang === 'zh-TW';
        const pages = [
          {
            id: 'home',
            url: `${siteBaseUrl}index.html`,
            title: isZh ? '英文首頁 (Home)' : 'English Homepage',
            description: isZh
              ? '主視覺、快速上手 (Quickstart)、核心特色、安全性基準與即時 Dashboard 面板。'
              : 'Hero, quickstart, key features, security architecture, and embedded live dashboard.',
            anchors: [
              { id: 'quickstart', href: `${siteBaseUrl}index.html#quickstart`, title: isZh ? '快速上手指令' : 'Quickstart Commands' },
              { id: 'features', href: `${siteBaseUrl}index.html#features`, title: isZh ? '核心特色' : 'Core Features' },
              { id: 'security', href: `${siteBaseUrl}index.html#security`, title: isZh ? '七大安全基準' : '7 Security Baselines' },
              { id: 'architecture', href: `${siteBaseUrl}index.html#architecture`, title: isZh ? '傳輸架構圖' : 'Architecture Diagram' },
              { id: 'live-dashboard', href: `${siteBaseUrl}index.html#home-dashboard-root`, title: isZh ? '本機連線面板' : 'Live Relay Connection Panel' }
            ]
          },
          {
            id: 'zh-TW',
            url: `${siteBaseUrl}zh-TW.html`,
            title: isZh ? '繁體中文首頁 (zh-TW)' : 'Traditional Chinese Homepage',
            description: isZh
              ? '專為繁體中文使用者設計之完整首頁、快速上手步驟與安全模型解說。'
              : 'Traditional Chinese localized homepage with full setup guides and security model.',
            anchors: [
              { id: 'quickstart', href: `${siteBaseUrl}zh-TW.html#quickstart`, title: isZh ? '快速上手指南' : 'Quickstart Guide' },
              { id: 'security', href: `${siteBaseUrl}zh-TW.html#security`, title: isZh ? '安全防禦圖' : 'Security Defense Map' }
            ]
          },
          {
            id: 'doc',
            url: `${siteBaseUrl}doc.html`,
            title: isZh ? '規範文件瀏覽器 (Docs SPA)' : 'Normative Documentation Viewer',
            description: isZh
              ? '內嵌規範閱讀器，支援中英文切換與 Mermaid 即時繪圖。'
              : 'Interactive SPA reader for normative specifications with bilingual support and Mermaid diagrams.',
            topics: [
              { topic: 'spec', href: `${siteBaseUrl}doc.html?d=spec`, title: isZh ? '完整規格 (Spec)' : 'Normative Spec' },
              { topic: 'protocol', href: `${siteBaseUrl}doc.html?d=protocol`, title: isZh ? '傳輸協定 (Protocol)' : 'Transport Protocol' },
              { topic: 'security', href: `${siteBaseUrl}doc.html?d=security`, title: isZh ? '安全基準 (Security)' : 'Security Model' },
              { topic: 'index', href: `${siteBaseUrl}doc.html?d=index`, title: isZh ? '文件總覽 (Index)' : 'Documentation Index' }
            ]
          },
          {
            id: 'dashboard',
            url: `${siteBaseUrl}dashboard.html`,
            title: isZh ? '本機管理儀表板 (Dashboard)' : 'Relay Management Dashboard',
            description: isZh
              ? '管理 MCP 站點、檢視分頁連線狀態、切換讀寫權限、管理 URL 前綴白名單與 /v1 允許來源。'
              : 'Manage MCP sites, inspect tab sessions, toggle read/write permissions, and manage allowlists.',
            anchors: [
              { id: 'sites-table', href: `${siteBaseUrl}dashboard.html#admin-dashboard-authenticated`, title: isZh ? '已註冊站點列表' : 'Registered MCP Sites' },
              { id: 'add-site', href: `${siteBaseUrl}dashboard.html#form-add-site`, title: isZh ? '新增站點表單' : 'Add MCP Site Form' },
              { id: 'prefix-allowlist', href: `${siteBaseUrl}dashboard.html#details-allow-prefix`, title: isZh ? 'URL Prefix 白名單' : 'URL Prefix Allowlist' },
              { id: 'allowed-origins', href: `${siteBaseUrl}dashboard.html#details-allowed-origins`, title: isZh ? '/v1 授權 Origin 清單' : 'Chat Completions Allowed Origins' }
            ]
          },
          {
            id: 'mcp',
            url: `${siteBaseUrl}mcp.html`,
            title: isZh ? 'WebMCP 工具測試頁面 (mcp.html)' : 'WebMCP Tools Catalog Page',
            description: isZh
              ? '展示目前站點暴露給 AI 的所有 WebMCP 工具，提供互動式參數表單與 direct query 執行。'
              : 'Interactive catalog of all tools exposed by the site to AI assistants with direct execution support.'
          }
        ];

        if (section) {
          const s = section.toLowerCase();
          const found = pages.find((p) => p.id === s || p.title.toLowerCase().includes(s));
          if (found) {
            return {
              section,
              lang,
              page: found
            };
          }
        }

        return {
          lang,
          siteBaseUrl,
          pages
        };
      }
    },
    {
      name: 'add_mcp',
      description:
        'Add and allow a new MCP Pages site URL in local ai-proxy and register it with Claude Code. NON-READ-ONLY TOOL: Only call this tool when the human user has explicitly asked to add that specific site URL.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Full URL or directory URL to the site MCP page (e.g. https://example.github.io/docs/ or https://example.github.io/docs/mcp)'
          },
          name: {
            type: 'string',
            description: 'Optional short server slug'
          },
          write: {
            type: 'boolean',
            description: 'Allow read/write access (default: true). Set false for read-only mode.',
            default: true
          },
          allowOrigin: {
            type: 'boolean',
            description: 'Automatically allow the site origin to access /v1 (default: true). Set false to leave origin unallowed.',
            default: true
          },
          allowPrefix: {
            type: 'boolean',
            description: 'Automatically allow the site URL prefix (default: true). Set false to skip prefix allowlist.',
            default: true
          }
        },
        required: ['url'],
        additionalProperties: false
      },
      annotations: {
        title: 'Add MCP Site (Requires User Request)',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      execute: executeAddSite
    },
    {
      name: 'add_site',
      description:
        'Add and allow a new MCP Pages site URL in local ai-proxy and register it with Claude Code. NON-READ-ONLY TOOL: Only call this tool when the human user has explicitly asked to add that specific site URL.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Full URL to the site MCP page (e.g. https://example.github.io/docs/mcp)'
          },
          name: {
            type: 'string',
            description: 'Optional short server slug'
          },
          write: {
            type: 'boolean',
            description: 'Allow read/write access (default: true). Set false for read-only mode.',
            default: true
          },
          allowOrigin: {
            type: 'boolean',
            description: 'Automatically allow the site origin to access /v1 (default: true). Set false to leave origin unallowed.',
            default: true
          },
          allowPrefix: {
            type: 'boolean',
            description: 'Automatically allow the site URL prefix (default: true). Set false to skip prefix allowlist.',
            default: true
          }
        },
        required: ['url'],
        additionalProperties: false
      },
      annotations: {
        title: 'Add MCP Site (Requires User Request)',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      execute: executeAddSite
    },
    {
      name: 'set_site_permission',
      description:
        'Update an MCP site access permission between read/write mode and read-only mode. NON-READ-ONLY TOOL: Only call this tool when the human user has explicitly requested to change site permissions.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Site URL to update'
          },
          write: {
            type: 'boolean',
            description: 'True to enable read/write mode, false for read-only mode'
          }
        },
        required: ['url', 'write'],
        additionalProperties: false
      },
      annotations: {
        title: 'Set Site Permission',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      execute: executeSetSitePermission
    },
    {
      name: 'remove_mcp',
      description:
        'Remove an MCP site from local ai-proxy, revoke its URL prefix from the allowlist, and unregister it from AI tools. DESTRUCTIVE NON-READ-ONLY TOOL: Only call this tool when the human user has explicitly asked to remove that specific site.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Normalized site URL to remove'
          }
        },
        required: ['url'],
        additionalProperties: false
      },
      annotations: {
        title: 'Remove MCP Site (Requires User Request)',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      },
      execute: executeRemoveSite
    },
    {
      name: 'remove_site',
      description:
        'Remove a site from local ai-proxy, revoke its URL prefix from the allowlist, and unregister it from AI tools. DESTRUCTIVE NON-READ-ONLY TOOL: Only call this tool when the human user has explicitly asked to remove that specific site.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Normalized site URL to remove'
          }
        },
        required: ['url'],
        additionalProperties: false
      },
      annotations: {
        title: 'Remove MCP Site (Requires User Request)',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      },
      execute: executeRemoveSite
    },
    {
      name: 'allow_origin',
      description:
        'Authorize an origin to use local /v1 chat completions endpoint, or "*" for wildcard pure-chat mode. NON-READ-ONLY TOOL: Only call this tool when the human user has explicitly asked to allow that origin.',
      inputSchema: {
        type: 'object',
        properties: {
          origin: {
            type: 'string',
            description: 'Origin URL (e.g. https://example.com) or "*" for open origin mode'
          },
          ttlSeconds: {
            type: 'number',
            description: 'Optional TTL expiration in seconds'
          }
        },
        required: ['origin'],
        additionalProperties: false
      },
      annotations: {
        title: 'Allow Origin for /v1 (Requires User Request)',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      execute: executeAllowOrigin
    },
    {
      name: 'add_allow_origin',
      description:
        'Authorize an origin to use local /v1 chat completions endpoint. Alias for allow_origin. NON-READ-ONLY TOOL: Only call this tool when the human user has explicitly asked to allow that origin.',
      inputSchema: {
        type: 'object',
        properties: {
          origin: {
            type: 'string',
            description: 'Origin URL (e.g. https://example.com) or "*" for open origin mode'
          },
          ttlSeconds: {
            type: 'number',
            description: 'Optional TTL expiration in seconds'
          }
        },
        required: ['origin'],
        additionalProperties: false
      },
      annotations: {
        title: 'Add Allow Origin (Requires User Request)',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      execute: executeAllowOrigin
    },
    {
      name: 'deny_origin',
      description:
        'Revoke an origin from accessing local /v1 chat completions endpoint. DESTRUCTIVE NON-READ-ONLY TOOL: Only call this tool when the human user has explicitly asked to revoke that origin.',
      inputSchema: {
        type: 'object',
        properties: {
          origin: {
            type: 'string',
            description: 'Origin URL to revoke'
          }
        },
        required: ['origin'],
        additionalProperties: false
      },
      annotations: {
        title: 'Deny Origin for /v1 (Requires User Request)',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      },
      execute: executeDenyOrigin
    },
    {
      name: 'remove_allow_origin',
      description:
        'Revoke an origin from accessing local /v1 chat completions endpoint. Alias for deny_origin. DESTRUCTIVE NON-READ-ONLY TOOL: Only call this tool when the human user has explicitly asked to revoke that origin.',
      inputSchema: {
        type: 'object',
        properties: {
          origin: {
            type: 'string',
            description: 'Origin URL to revoke'
          }
        },
        required: ['origin'],
        additionalProperties: false
      },
      annotations: {
        title: 'Remove Allow Origin (Requires User Request)',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      },
      execute: executeDenyOrigin
    },
    {
      name: 'allow_prefix',
      description:
        'Add a URL prefix to the relay allowlist. NON-READ-ONLY TOOL: Only call this tool when the human user has explicitly asked to allow that prefix.',
      inputSchema: {
        type: 'object',
        properties: {
          prefix: {
            type: 'string',
            description: 'URL prefix to allow (e.g. https://example.github.io/)'
          }
        },
        required: ['prefix'],
        additionalProperties: false
      },
      annotations: {
        title: 'Allow URL Prefix (Requires User Request)',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      execute: executeAllowPrefix
    },
    {
      name: 'deny_prefix',
      description:
        'Remove a URL prefix from the relay allowlist. DESTRUCTIVE NON-READ-ONLY TOOL: Only call this tool when the human user has explicitly asked to deny that prefix.',
      inputSchema: {
        type: 'object',
        properties: {
          prefix: {
            type: 'string',
            description: 'URL prefix to remove from allowlist'
          }
        },
        required: ['prefix'],
        additionalProperties: false
      },
      annotations: {
        title: 'Deny URL Prefix (Requires User Request)',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      },
      execute: executeDenyPrefix
    }
  ];

  const uiInstance = await mountMcpPageUi({
    container: catalogContainer,
    title: 'ai-proxy Built-in MCP Page',
    tools,
    win
  });

  let adminCtrl = null;
  if (adminContainer) {
    adminContainer.hidden = false;
    adminCtrl = await mountAdminDashboard({
      container: adminContainer,
      adminKey: hs.adminKey,
      mcpPort,
      win
    });
  }

  return {
    ...uiInstance,
    adminCtrl
  };
}
