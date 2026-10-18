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
