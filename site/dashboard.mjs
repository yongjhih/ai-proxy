/**
 * Dashboard & Admin Management Panel for ai-proxy (/admin/v1/*).
 * Used both on standalone dashboard.html and inline on mcp.html when opened with an admin key.
 */

import { extractHandshake } from '../web/handshake.mjs';
import { probeRelay } from '../web/client.mjs';
import { resolveMcpEndpoint } from '../web/url.mjs';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function getRequestedAddUrl(win = globalThis.window) {
  if (!win || !win.location) return '';
  // Check hash first
  const rawHash = win.location.hash ? win.location.hash.replace(/^#/, '') : '';
  if (rawHash) {
    const hashParams = new URLSearchParams(rawHash);
    const fromHash = hashParams.get('add-url') || hashParams.get('add_url') || hashParams.get('add');
    if (fromHash) return fromHash.trim();
  }
  // Check search query
  if (win.location.search) {
    const searchParams = new URLSearchParams(win.location.search);
    const fromSearch = searchParams.get('add-url') || searchParams.get('add_url') || searchParams.get('add');
    if (fromSearch) return fromSearch.trim();
  }
  return '';
}

export function cleanAddUrlFromLocation(win = globalThis.window) {
  if (!win || !win.location || !win.history || typeof win.history.replaceState !== 'function') return;
  try {
    let changed = false;
    let newHash = win.location.hash || '';
    if (newHash) {
      const rawHash = newHash.replace(/^#/, '');
      const params = new URLSearchParams(rawHash);
      if (params.has('add-url') || params.has('add_url') || params.has('add')) {
        params.delete('add-url');
        params.delete('add_url');
        params.delete('add');
        const rem = params.toString();
        newHash = rem ? `#${rem}` : '';
        changed = true;
      }
    }
    let newSearch = win.location.search || '';
    if (newSearch) {
      const params = new URLSearchParams(newSearch);
      if (params.has('add-url') || params.has('add_url') || params.has('add')) {
        params.delete('add-url');
        params.delete('add_url');
        params.delete('add');
        const rem = params.toString();
        newSearch = rem ? `?${rem}` : '';
        changed = true;
      }
    }
    if (changed) {
      win.history.replaceState(win.history.state, '', win.location.pathname + newSearch + newHash);
    }
  } catch {}
}

export async function mountAdminDashboard({
  container,
  adminKey: explicitAdminKey = undefined,
  mcpPort: explicitPort = undefined,
  win = globalThis.window
} = {}) {
  if (!container) return null;
  let isAutoAdding = false;
  let hs = extractHandshake(win);
  let adminKey = explicitAdminKey !== undefined ? explicitAdminKey : hs.adminKey;
  const urlPort = win && win.location && win.location.port ? Number.parseInt(win.location.port, 10) : 0;
  let mcpPort = explicitPort || (hs.mcpPort !== 8788 ? hs.mcpPort : urlPort || 8788);
  let baseUrl = `http://127.0.0.1:${mcpPort}`;

  let broadcastChan = null;
  try {
    if (win && typeof win.BroadcastChannel === 'function') {
      broadcastChan = new win.BroadcastChannel('ai_proxy_admin_channel');
      broadcastChan.onmessage = (ev) => {
        if (ev && ev.data && ev.data.adminKey) {
          adminKey = ev.data.adminKey;
          if (ev.data.mcpPort) {
            mcpPort = ev.data.mcpPort;
            baseUrl = `http://127.0.0.1:${mcpPort}`;
          }
          if (win && win.history && typeof win.history.replaceState === 'function') {
            const currentState =
              win.history.state && typeof win.history.state === 'object' ? { ...win.history.state } : {};
            currentState.__aiProxy = {
              ...(currentState.__aiProxy || {}),
              adminKey,
              mcpPort
            };
            win.history.replaceState(currentState, '', win.location.pathname + win.location.search);
          }
          refreshDashboard();
        }
      };
    }
  } catch {
    // broadcast channel optional
  }

  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('hashchange', async () => {
      const updatedHs = extractHandshake(win);
      if (updatedHs.adminKey) {
        adminKey = updatedHs.adminKey;
        if (updatedHs.mcpPort) {
          mcpPort = updatedHs.mcpPort;
          baseUrl = `http://127.0.0.1:${mcpPort}`;
        }
        await refreshDashboard();
      }
    });
  }

  function broadcastAdminKey(key, port) {
    if (broadcastChan) {
      try {
        broadcastChan.postMessage({ adminKey: key, mcpPort: port });
      } catch {}
    }
  }

  if (adminKey) {
    broadcastAdminKey(adminKey, mcpPort);
    if (win && win.opener && typeof win.opener.postMessage === 'function') {
      try {
        win.opener.postMessage({ type: 'ai_proxy_admin_key', adminKey, mcpPort }, '*');
      } catch {}
    }
  }

  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('message', (ev) => {
      if (ev && ev.data && ev.data.type === 'ai_proxy_admin_key' && ev.data.adminKey) {
        adminKey = ev.data.adminKey;
        if (ev.data.mcpPort) {
          mcpPort = ev.data.mcpPort;
          baseUrl = `http://127.0.0.1:${mcpPort}`;
        }
        if (win && win.history && typeof win.history.replaceState === 'function') {
          const currentState =
            win.history.state && typeof win.history.state === 'object' ? { ...win.history.state } : {};
          currentState.__aiProxy = {
            ...(currentState.__aiProxy || {}),
            adminKey,
            mcpPort
          };
          win.history.replaceState(currentState, '', win.location.pathname + win.location.search);
        }
        refreshDashboard();
      }
    });

    win.addEventListener('hashchange', () => {
      if (win.location && win.location.hash) {
        hs = extractHandshake(win);
        if (hs.adminKey) {
          adminKey = hs.adminKey;
          broadcastAdminKey(adminKey, hs.mcpPort || mcpPort);
          if (win && win.opener && typeof win.opener.postMessage === 'function') {
            try {
              win.opener.postMessage(
                { type: 'ai_proxy_admin_key', adminKey, mcpPort: hs.mcpPort || mcpPort },
                '*'
              );
            } catch {}
          }
        }
        if (hs.mcpPort) {
          mcpPort = hs.mcpPort;
          baseUrl = `http://127.0.0.1:${mcpPort}`;
        }
        refreshDashboard();
      }
    });
  }

  let feedbackMessage = '';
  let feedbackKind = 'info';

  function setFeedback(msg, kind = 'info') {
    feedbackMessage = msg;
    feedbackKind = kind;
  }

  async function adminFetch(path, init = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(adminKey ? { Authorization: `Bearer ${adminKey}` } : {}),
        ...(init.headers || {})
      }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function renderUnauthenticated() {
    const reachable = await probeRelay({ mcpPort });
    const pageUrl = win && win.location ? win.location.href.split('#')[0] : '';
    const pendingAddUrl = getRequestedAddUrl(win);
    let connectHref = `${baseUrl}/admin/v1/open-dashboard?redirect=${encodeURIComponent(pageUrl)}`;
    if (pendingAddUrl) {
      connectHref += `&add-url=${encodeURIComponent(pendingAddUrl)}`;
    }

    const autoAttemptKey = 'ai_proxy_auto_connect_attempted';
    let alreadyAttempted = false;
    try {
      if (win && win.sessionStorage) {
        const lastAttempt = Number.parseInt(win.sessionStorage.getItem(autoAttemptKey) || '0', 10);
        if (Date.now() - lastAttempt < 15000) {
          alreadyAttempted = true;
        }
      }
    } catch {}

    if (reachable && pendingAddUrl && !alreadyAttempted) {
      try {
        if (win && win.sessionStorage) {
          win.sessionStorage.setItem(autoAttemptKey, String(Date.now()));
        }
      } catch {}
      if (win && win.location) {
        win.location.href = connectHref;
        return;
      }
    }

    const pendingAddBanner = pendingAddUrl
      ? `
        <div class="flash-banner flash-info" id="pending-add-banner" style="margin-bottom:0.75rem;">
          <strong>準備接入站點：</strong> <code>${escapeHtml(pendingAddUrl)}</code>。<br />
          點擊下方「Connect (接上本機 ai-proxy)」將自動為您連線並直接完成接入。
        </div>`
      : '';

    container.innerHTML = `
      <div class="primer-box" id="dashboard-connect-box">
        <div class="primer-box-header">
          <h2>Connect to Local ai-proxy</h2>
          <span class="badge ${reachable ? 'badge-success' : 'badge-neutral'}" id="relay-probe-badge">
            ${reachable ? `Relay detected on 127.0.0.1:${mcpPort}` : `No relay detected on 127.0.0.1:${mcpPort}`}
          </span>
        </div>
        <div class="primer-box-row">
          ${pendingAddBanner}
          <p>
            Connect to your local <code>ai-proxy</code> relay to manage registered MCP sites, URL prefix allowlists, and key rotation directly in this tab.
          </p>
          <div class="form-row" style="gap:0.75rem;align-items:center;">
            <a href="${escapeHtml(connectHref)}" class="btn btn-primary" id="btn-connect-dashboard">
              Connect (接上本機 ai-proxy)
            </a>
            <span style="color:var(--fg-muted);font-size:0.875rem;">或直接貼上管理金鑰：</span>
          </div>
          <form id="form-manual-admin-key" class="form-row" style="margin-top:0.75rem;">
            <input type="password" name="adminKey" placeholder="adm_... (paste admin-key to unlock dashboard in-place)" style="flex:1;min-width:16rem;" required />
            <button type="submit" class="btn" id="btn-unlock-dashboard">Unlock Dashboard</button>
          </form>
          <div id="connect-feedback" style="margin-top:0.75rem;"></div>
        </div>
      </div>
    `;

    const connectBtn = container.querySelector('#btn-connect-dashboard');
    const manualForm = container.querySelector('#form-manual-admin-key');
    const feedbackEl = container.querySelector('#connect-feedback');

    function applyAdminKeyInPlace(newKey) {
      if (!newKey) return;
      adminKey = newKey;
      broadcastAdminKey(newKey, mcpPort);
      if (win && win.history && typeof win.history.replaceState === 'function') {
        const currentState =
          win.history.state && typeof win.history.state === 'object' ? { ...win.history.state } : {};
        currentState.__aiProxy = {
          ...(currentState.__aiProxy || {}),
          adminKey: newKey,
          mcpPort
        };
        win.history.replaceState(currentState, '', win.location.pathname + win.location.search);
      }
      refreshDashboard();
    }

    if (connectBtn) {
      connectBtn.addEventListener('click', (ev) => {
        if (win && win.location) {
          ev.preventDefault();
          win.location.href = connectHref;
        }
      });
    }

    if (manualForm) {
      manualForm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const fd = new FormData(manualForm);
        const enteredKey = String(fd.get('adminKey') || '').trim();
        if (!enteredKey) return;
        applyAdminKeyInPlace(enteredKey);
      });
    }
  }

  async function refreshDashboard() {
    if (!adminKey) {
      await renderUnauthenticated();
      return;
    }

    let status;
    try {
      status = await adminFetch('/admin/v1/status');
    } catch (err) {
      if (err.status === 401) {
        await renderUnauthenticated();
        return;
      }
      container.innerHTML = `<div class="flash-banner flash-danger">Failed to query /admin/v1/status: ${escapeHtml(
        err.message
      )}</div>`;
      return;
    }

    const warningsHtml = (status.warnings || [])
      .map(
        (w) =>
          `<div class="flash-banner flash-warning" data-testid="open-origin-warning"><strong>Security Notice:</strong> ${escapeHtml(
            w
          )}</div>`
      )
      .join('');

    const feedbackHtml = feedbackMessage
      ? `<div class="flash-banner ${
          feedbackKind === 'danger' ? 'flash-danger' : ''
        }" id="admin-feedback">${escapeHtml(feedbackMessage)}</div>`
      : '';

    const siteRows =
      status.sites && status.sites.length > 0
        ? status.sites
            .map((s) => {
              const siteOrigin = (() => {
                try {
                  return new URL(s.url).origin;
                } catch {
                  return '';
                }
              })();
              const isOriginAllowed = Boolean(
                siteOrigin &&
                  Array.isArray(status.allowedOrigins) &&
                  status.allowedOrigins.includes(siteOrigin)
              );
              return `
          <tr data-site-url="${escapeHtml(s.url)}" id="site-row-${encodeURIComponent(s.url).replace(/[^a-zA-Z0-9_-]/g, '_')}">
            <td><code>${escapeHtml(s.name)}</code></td>
            <td><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.url)}</a></td>
            <td>
              <span class="badge ${s.connected ? 'badge-success' : 'badge-neutral'}">
                ${s.connected ? `Connected (${escapeHtml(s.sessionId || '')})` : 'Idle / Disconnected'}
              </span>
            </td>
            <td>
              <div style="display:flex;flex-direction:column;gap:0.25rem;">
                <span class="badge ${s.write !== false ? 'badge-success' : 'badge-readonly'}" title="${s.write !== false ? 'Read/Write allowed' : 'Read-only mode'}">
                  ${s.write !== false ? 'Read/Write' : 'Read-Only'}
                </span>
                ${
                  siteOrigin
                    ? `<span class="badge ${isOriginAllowed ? 'badge-success' : 'badge-neutral'}" title="${
                        isOriginAllowed ? 'Origin authorized on /v1' : 'Origin not authorized on /v1'
                      }">
                    ${isOriginAllowed ? 'Origin: Allowed' : 'Origin: Denied'}
                  </span>`
                    : ''
                }
              </div>
            </td>
            <td><code>${Array.isArray(s.tools) ? s.tools.length : 0}</code></td>
            <td>
              <div class="form-row">
                <button type="button" class="btn btn-sm btn-toggle-site-mode" data-url="${escapeHtml(s.url)}" data-write="${s.write !== false ? 'false' : 'true'}">${s.write !== false ? 'Set Read-Only' : 'Allow Write'}</button>
                ${
                  siteOrigin
                    ? `<button type="button" class="btn btn-sm btn-toggle-site-origin" data-origin="${escapeHtml(
                        siteOrigin
                      )}" data-allowed="${isOriginAllowed ? 'true' : 'false'}">${
                        isOriginAllowed ? 'Revoke Origin' : 'Allow Origin'
                      }</button>`
                    : ''
                }
                <button type="button" class="btn btn-sm btn-rotate-site" data-url="${escapeHtml(s.url)}">Rotate Key</button>
                <button type="button" class="btn btn-sm btn-danger btn-remove-site" data-url="${escapeHtml(s.url)}">Remove</button>
              </div>
            </td>
          </tr>
        `;
            })
            .join('')
        : `<tr><td colspan="6">No MCP sites registered yet. Add a site below to allow its prefix and register it in Claude Code.</td></tr>`;

    const allowlistRows =
      status.allowlist && status.allowlist.length > 0
        ? status.allowlist
            .map(
              (prefix) => `
          <div class="primer-box-row form-row" style="justify-content:space-between;">
            <code>${escapeHtml(prefix)}</code>
            <button type="button" class="btn btn-sm btn-danger btn-deny-prefix" data-prefix="${escapeHtml(
              prefix
            )}">Deny Prefix</button>
          </div>
        `
            )
            .join('')
        : `<div class="primer-box-row">Only <code>localhost</code> / <code>127.0.0.1</code> allowed. Add remote prefixes below.</div>`;

    const originRows =
      status.allowedOrigins && status.allowedOrigins.length > 0
        ? status.allowedOrigins
            .map(
              (origin) => `
          <div class="primer-box-row form-row" style="justify-content:space-between;">
            <code>${escapeHtml(origin)}</code>
            <button type="button" class="btn btn-sm btn-danger btn-deny-origin" data-origin="${escapeHtml(
              origin
            )}">Revoke Origin</button>
          </div>
        `
            )
            .join('')
        : `<div class="primer-box-row">Only dashboard origin allowed on <code>/v1</code>.</div>`;

    const openOriginEnabled = Boolean(status.openOriginMode && status.openOriginMode.enabled);

    container.innerHTML = `
      <div class="admin-dashboard" id="admin-dashboard-authenticated">
        ${warningsHtml}
        ${feedbackHtml}

        <section class="primer-box">
          <div class="primer-box-header">
            <h2>MCP sites (${status.sites ? status.sites.length : 0})</h2>
            <span class="badge badge-success">Port ${escapeHtml(status.port)} · Authenticated</span>
          </div>
          <div class="primer-box-row">
            <form id="form-add-site" class="form-row" style="flex-wrap:wrap;align-items:center;gap:0.75rem;">
              <input type="url" name="url" placeholder="https://example.github.io/example/" required style="flex:1;min-width:240px;" />
              <input type="text" name="name" placeholder="Optional name (e.g. docs-site)" style="min-width:180px;" />
              <div style="display:inline-flex;align-items:center;gap:0.75rem;flex-wrap:wrap;">
                <label style="display:inline-flex;align-items:center;gap:0.35rem;font-size:0.875rem;cursor:pointer;user-select:none;">
                  <input type="checkbox" name="write" value="true" checked id="checkbox-add-site-write" />
                  <span>Allow Write (讀寫支援)</span>
                </label>
                <label style="display:inline-flex;align-items:center;gap:0.35rem;font-size:0.875rem;cursor:pointer;user-select:none;">
                  <input type="checkbox" name="allowOrigin" value="true" checked id="checkbox-add-site-origin" />
                  <span>Allow Origin (自動授權 Origin /v1)</span>
                </label>
                <label style="display:inline-flex;align-items:center;gap:0.35rem;font-size:0.875rem;cursor:pointer;user-select:none;">
                  <input type="checkbox" name="allowPrefix" value="true" checked id="checkbox-add-site-prefix" />
                  <span>Allow Prefix (自動加入路徑白名單)</span>
                </label>
              </div>
              <button type="submit" class="btn btn-primary" id="btn-add-site">Add Site</button>
            </form>
            <div style="font-size:0.75rem;color:var(--fg-muted);margin-top:0.375rem;">
              支援直接填寫站點路徑（如 <code>https://example.github.io/example/</code>），自動尋找預設 <code>/mcp</code> 或 <code>/mcp.html</code>。可勾選自動授權 Origin（供 <code>/v1</code> 存取）、URL Prefix 白名單與讀寫模式（預設全勾選）。
            </div>
          </div>
          <div class="data-table-wrap" style="margin:0;border:none;border-top:1px solid var(--border-default);border-radius:0;">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Page URL</th>
                  <th>Tab Status</th>
                  <th>Mode</th>
                  <th>Tools</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${siteRows}
              </tbody>
            </table>
          </div>
        </section>

        <details class="primer-box" id="details-allow-prefix">
          <summary class="primer-box-header">
            <div style="display:flex;align-items:center;gap:0.5rem;">
              <span class="details-marker">▶</span>
              <h2>URL Prefix Allowlist (Path-Boundary Matched)</h2>
            </div>
            <span class="badge badge-neutral">${status.allowlist ? status.allowlist.length : 0} configured</span>
          </summary>
          <div class="primer-box-row">
            <form id="form-allow-prefix" class="form-row">
              <input type="url" name="prefix" placeholder="https://example.github.io/project/" required style="flex:1;" />
              <button type="submit" class="btn" id="btn-allow-prefix">Allow Prefix</button>
            </form>
          </div>
          ${allowlistRows}
        </details>

        <details class="primer-box" id="details-allowed-origins">
          <summary class="primer-box-header">
            <div style="display:flex;align-items:center;gap:0.5rem;">
              <span class="details-marker">▶</span>
              <h2><code>/v1</code> Chat Completions Allowed Origins</h2>
            </div>
            <span class="badge ${openOriginEnabled ? 'badge-warning' : 'badge-readonly'}">
              ${openOriginEnabled ? 'Wildcard (*) Pure Chat Active' : 'Origin-Restricted'}
            </span>
          </summary>
          <div class="primer-box-row">
            <form id="form-allow-origin" class="form-row">
              <input type="text" name="origin" placeholder="https://example.github.io" required style="flex:1;" />
              <button type="submit" class="btn" id="btn-allow-origin">Allow Origin</button>
            </form>
            <div class="form-row" style="margin-top:0.75rem;">
              ${
                openOriginEnabled
                  ? `<button type="button" class="btn btn-danger" id="btn-disable-open-origin">Disable Wildcard (*) Mode</button>`
                  : `<button type="button" class="btn" id="btn-enable-open-origin">Enable Wildcard (*) Pure Chat (15m TTL, 0 Tools)</button>`
              }
            </div>
          </div>
          ${originRows}
        </details>

        <details class="primer-box" id="details-key-mgmt">
          <summary class="primer-box-header">
            <div style="display:flex;align-items:center;gap:0.5rem;">
              <span class="details-marker">▶</span>
              <h2>Key Management &amp; Rotation</h2>
            </div>
          </summary>
          <div class="primer-box-row form-row">
            <button type="button" class="btn" id="btn-rotate-all-keys">Rotate All Site Keys</button>
            <button type="button" class="btn btn-danger" id="btn-rotate-admin-key">Rotate Admin Key</button>
          </div>
        </details>
      </div>
    `;

    // Wire Add Site
    const addSiteForm = container.querySelector('#form-add-site');
    const requestedAddUrl = getRequestedAddUrl(win);
    if (addSiteForm && requestedAddUrl && !isAutoAdding) {
      const urlInput = addSiteForm.querySelector('input[name="url"]');
      if (urlInput) {
        urlInput.value = requestedAddUrl;
      }
      const alreadyAdded =
        status.sites &&
        status.sites.some(
          (s) =>
            s.url === requestedAddUrl ||
            s.url.replace(/\/$/, '') === requestedAddUrl.replace(/\/$/, '') ||
            (typeof s.url === 'string' &&
              s.url.endsWith('/mcp') &&
              s.url.slice(0, -4).replace(/\/$/, '') === requestedAddUrl.replace(/\/$/, ''))
        );

      if (!alreadyAdded) {
        isAutoAdding = true;
        cleanAddUrlFromLocation(win);
        (async () => {
          try {
            setFeedback(`正在直接接入 MCP 站點：${requestedAddUrl}...`);
            const fetchFn = win && typeof win.fetch === 'function' ? win.fetch.bind(win) : globalThis.fetch;
            const targetUrl = await resolveMcpEndpoint(requestedAddUrl, { fetchFn });
            const res = await adminFetch('/admin/v1/sites', {
              method: 'POST',
              body: JSON.stringify({
                url: targetUrl,
                write: true,
                allowOrigin: true,
                allowPrefix: true
              })
            });
            const extras = [];
            if (res.site.write !== false) extras.push('Read/Write');
            else extras.push('Read-Only');
            extras.push('Origin allowed', 'Prefix allowed');
            setFeedback(`已直接接入 MCP 站點：${res.site.url} (${extras.join(', ')})`);
            await refreshDashboard();
          } catch (err) {
            setFeedback(`接入失敗：${err.message}`, 'danger');
          } finally {
            isAutoAdding = false;
          }
        })();
      } else {
        setFeedback(`MCP 站點已在清單中：${requestedAddUrl}`);
        cleanAddUrlFromLocation(win);
      }
    }

    if (addSiteForm) {
      addSiteForm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const fd = new FormData(addSiteForm);
        const inputUrl = String(fd.get('url') || '').trim();
        const name = String(fd.get('name') || '').trim() || undefined;
        const writeCheckbox = addSiteForm.querySelector('#checkbox-add-site-write');
        const originCheckbox = addSiteForm.querySelector('#checkbox-add-site-origin');
        const prefixCheckbox = addSiteForm.querySelector('#checkbox-add-site-prefix');
        const write = writeCheckbox ? writeCheckbox.checked : true;
        const allowOrigin = originCheckbox ? originCheckbox.checked : true;
        const allowPrefix = prefixCheckbox ? prefixCheckbox.checked : true;
        try {
          const fetchFn = win && typeof win.fetch === 'function' ? win.fetch.bind(win) : globalThis.fetch;
          const targetUrl = await resolveMcpEndpoint(inputUrl, { fetchFn });
          const res = await adminFetch('/admin/v1/sites', {
            method: 'POST',
            body: JSON.stringify({ url: targetUrl, name, write, allowOrigin, allowPrefix })
          });
          const extras = [];
          if (res.site.write !== false) extras.push('Read/Write');
          else extras.push('Read-Only');
          if (allowOrigin) extras.push('Origin allowed');
          if (allowPrefix) extras.push('Prefix allowed');
          setFeedback(`Added MCP site: ${res.site.url} (${extras.join(', ')})`);

          cleanAddUrlFromLocation(win);
        } catch (err) {
          setFeedback(err.message, 'danger');
        }
        await refreshDashboard();
      });
    }

    // Wire Toggle Site Mode (Read/Write vs Read-Only)
    for (const btn of container.querySelectorAll('.btn-toggle-site-mode')) {
      btn.addEventListener('click', async () => {
        const url = btn.getAttribute('data-url');
        const nextWrite = btn.getAttribute('data-write') === 'true';
        try {
          await adminFetch('/admin/v1/sites/permission', {
            method: 'POST',
            body: JSON.stringify({ url, write: nextWrite })
          });
          setFeedback(`Updated site mode for ${url} to ${nextWrite ? 'Read/Write' : 'Read-Only'}`);
        } catch (err) {
          setFeedback(err.message, 'danger');
        }
        await refreshDashboard();
      });
    }

    // Wire Toggle Site Origin
    for (const btn of container.querySelectorAll('.btn-toggle-site-origin')) {
      btn.addEventListener('click', async () => {
        const origin = btn.getAttribute('data-origin');
        const isCurrentlyAllowed = btn.getAttribute('data-allowed') === 'true';
        try {
          await adminFetch('/admin/v1/origins', {
            method: 'POST',
            body: JSON.stringify({
              action: isCurrentlyAllowed ? 'deny' : 'allow',
              origin
            })
          });
          setFeedback(
            isCurrentlyAllowed
              ? `Revoked /v1 origin: ${origin}`
              : `Allowed /v1 origin: ${origin}`
          );
        } catch (err) {
          setFeedback(err.message, 'danger');
        }
        await refreshDashboard();
      });
    }

    // Wire Remove Site buttons
    for (const btn of container.querySelectorAll('.btn-remove-site')) {
      btn.addEventListener('click', async () => {
        const url = btn.getAttribute('data-url');
        try {
          await adminFetch('/admin/v1/sites', {
            method: 'DELETE',
            body: JSON.stringify({ url })
          });
          setFeedback(`Removed site: ${url}`);
        } catch (err) {
          setFeedback(err.message, 'danger');
        }
        await refreshDashboard();
      });
    }

    // Wire Rotate single site key
    for (const btn of container.querySelectorAll('.btn-rotate-site')) {
      btn.addEventListener('click', async () => {
        const url = btn.getAttribute('data-url');
        try {
          await adminFetch('/admin/v1/keys/rotate', {
            method: 'POST',
            body: JSON.stringify({ url })
          });
          setFeedback(`Rotated key for ${url}`);
        } catch (err) {
          setFeedback(err.message, 'danger');
        }
        await refreshDashboard();
      });
    }

    // Wire Allow Prefix
    const allowPrefixForm = container.querySelector('#form-allow-prefix');
    if (allowPrefixForm) {
      allowPrefixForm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const fd = new FormData(allowPrefixForm);
        const prefix = String(fd.get('prefix') || '').trim();
        try {
          await adminFetch('/admin/v1/allow', {
            method: 'POST',
            body: JSON.stringify({ prefix })
          });
          setFeedback(`Allowed prefix: ${prefix}`);
        } catch (err) {
          setFeedback(err.message, 'danger');
        }
        await refreshDashboard();
      });
    }

    // Wire Deny Prefix
    for (const btn of container.querySelectorAll('.btn-deny-prefix')) {
      btn.addEventListener('click', async () => {
        const prefix = btn.getAttribute('data-prefix');
        try {
          await adminFetch('/admin/v1/deny', {
            method: 'POST',
            body: JSON.stringify({ prefix })
          });
          setFeedback(`Removed prefix from allowlist: ${prefix}`);
        } catch (err) {
          setFeedback(err.message, 'danger');
        }
        await refreshDashboard();
      });
    }

    // Wire Allow Origin
    const allowOriginForm = container.querySelector('#form-allow-origin');
    if (allowOriginForm) {
      allowOriginForm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const fd = new FormData(allowOriginForm);
        const origin = String(fd.get('origin') || '').trim();
        try {
          await adminFetch('/admin/v1/origins', {
            method: 'POST',
            body: JSON.stringify({ action: 'allow', origin })
          });
          setFeedback(`Allowed /v1 origin: ${origin}`);
        } catch (err) {
          setFeedback(err.message, 'danger');
        }
        await refreshDashboard();
      });
    }

    // Wire Deny Origin
    for (const btn of container.querySelectorAll('.btn-deny-origin')) {
      btn.addEventListener('click', async () => {
        const origin = btn.getAttribute('data-origin');
        try {
          await adminFetch('/admin/v1/origins', {
            method: 'POST',
            body: JSON.stringify({ action: 'deny', origin })
          });
          setFeedback(`Revoked /v1 origin: ${origin}`);
        } catch (err) {
          setFeedback(err.message, 'danger');
        }
        await refreshDashboard();
      });
    }

    // Wire Enable/Disable Wildcard (*) Open-Origin Chat
    const enableStarBtn = container.querySelector('#btn-enable-open-origin');
    if (enableStarBtn) {
      enableStarBtn.addEventListener('click', async () => {
        try {
          await adminFetch('/admin/v1/origins', {
            method: 'POST',
            body: JSON.stringify({ action: 'allow', origin: '*', ttlSeconds: 900 })
          });
          setFeedback('Enabled wildcard (*) pure-chat mode for 15 minutes (0 tools allowed).');
        } catch (err) {
          setFeedback(err.message, 'danger');
        }
        await refreshDashboard();
      });
    }

    const disableStarBtn = container.querySelector('#btn-disable-open-origin');
    if (disableStarBtn) {
      disableStarBtn.addEventListener('click', async () => {
        try {
          await adminFetch('/admin/v1/origins', {
            method: 'POST',
            body: JSON.stringify({ action: 'deny', origin: '*' })
          });
          setFeedback('Disabled wildcard (*) mode on /v1.');
        } catch (err) {
          setFeedback(err.message, 'danger');
        }
        await refreshDashboard();
      });
    }

    // Wire Rotate All Site Keys
    const rotateAllBtn = container.querySelector('#btn-rotate-all-keys');
    if (rotateAllBtn) {
      rotateAllBtn.addEventListener('click', async () => {
        try {
          const res = await adminFetch('/admin/v1/keys/rotate', {
            method: 'POST',
            body: JSON.stringify({ rotateAdmin: false })
          });
          setFeedback(`Rotated ${res.rotated.length} site key(s).`);
        } catch (err) {
          setFeedback(err.message, 'danger');
        }
        await refreshDashboard();
      });
    }

    // Wire Rotate Admin Key
    const rotateAdminBtn = container.querySelector('#btn-rotate-admin-key');
    if (rotateAdminBtn) {
      rotateAdminBtn.addEventListener('click', async () => {
        try {
          await adminFetch('/admin/v1/keys/rotate', {
            method: 'POST',
            body: JSON.stringify({ rotateAdmin: true })
          });
          setFeedback('Admin key rotated. Re-connect to load the new admin key.');
        } catch (err) {
          setFeedback(err.message, 'danger');
        }
        await refreshDashboard();
      });
    }

    // Wire Refresh Dashboard Event
    if (win && typeof win.addEventListener === 'function') {
      win.__aiProxyRefreshDashboard = refreshDashboard;
      try {
        win.addEventListener('ai-proxy-refresh-dashboard', () => {
          refreshDashboard();
        });
      } catch {}
    }
  }

  await refreshDashboard();
  return { refreshDashboard };
}
