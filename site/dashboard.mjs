/**
 * Dashboard & Admin Management Panel for ai-proxy (/admin/v1/*).
 * Used both on standalone dashboard.html and inline on mcp.html when opened with an admin key.
 */

import { extractHandshake } from '../web/handshake.mjs';
import { probeRelay } from '../web/client.mjs';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function mountAdminDashboard({
  container,
  adminKey: explicitAdminKey = undefined,
  mcpPort: explicitPort = undefined,
  win = globalThis.window
} = {}) {
  if (!container) return null;
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
    container.innerHTML = `
      <div class="primer-box" id="dashboard-connect-box">
        <div class="primer-box-header">
          <h2>Connect to Local ai-proxy</h2>
          <span class="badge ${reachable ? 'badge-success' : 'badge-neutral'}" id="relay-probe-badge">
            ${reachable ? `Relay detected on 127.0.0.1:${mcpPort}` : `No relay detected on 127.0.0.1:${mcpPort}`}
          </span>
        </div>
        <div class="primer-box-row">
          <p>
            Connect to your local <code>ai-proxy</code> relay to manage registered MCP sites, URL prefix allowlists, and key rotation directly in this tab.
          </p>
          <div class="form-row" style="gap:0.75rem;align-items:center;">
            <button type="button" class="btn btn-primary" id="btn-connect-dashboard">
              Connect (接上本機 ai-proxy)
            </button>
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
      connectBtn.addEventListener('click', async () => {
        connectBtn.disabled = true;
        if (feedbackEl) {
          feedbackEl.innerHTML = '<span class="mono">Connecting to local ai-proxy relay...</span>';
        }
        try {
          const pageUrl = win && win.location ? win.location.href : undefined;
          await adminFetch('/admin/v1/open-dashboard', {
            method: 'POST',
            body: JSON.stringify({ pageUrl })
          });
          if (feedbackEl) {
            feedbackEl.innerHTML = `
              <div class="flash-banner flash-warning" style="margin-bottom:0.5rem;">
                <strong>已請求本機 ai-proxy 授權！</strong> 若瀏覽器已自動在新分頁開啟帶金鑰的儀表板，本頁將自動透過跨分頁頻道同步解鎖。
                <div style="margin-top:0.5rem;">
                  您也可以執行 <code class="mono">cat ~/.config/ai-proxy/config.json | grep adminKey</code> 並貼至上方輸入框立即解鎖原地展示。
                </div>
              </div>
            `;
          }
        } catch (err) {
          if (feedbackEl) {
            feedbackEl.innerHTML = `<div class="flash-banner flash-danger">Failed to connect to local relay: ${escapeHtml(
              err.message
            )}</div>`;
          }
        } finally {
          connectBtn.disabled = false;
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
            .map(
              (s) => `
          <tr data-site-url="${escapeHtml(s.url)}">
            <td><code>${escapeHtml(s.name)}</code></td>
            <td><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.url)}</a></td>
            <td>
              <span class="badge ${s.connected ? 'badge-success' : 'badge-neutral'}">
                ${s.connected ? `Connected (${escapeHtml(s.sessionId || '')})` : 'Idle / Disconnected'}
              </span>
            </td>
            <td><code>${Array.isArray(s.tools) ? s.tools.length : 0}</code></td>
            <td>
              <div class="form-row">
                <button type="button" class="btn btn-sm btn-rotate-site" data-url="${escapeHtml(s.url)}">Rotate Key</button>
                <button type="button" class="btn btn-sm btn-danger btn-remove-site" data-url="${escapeHtml(s.url)}">Remove</button>
              </div>
            </td>
          </tr>
        `
            )
            .join('')
        : `<tr><td colspan="5">No MCP sites registered yet. Add a site below to allow its prefix and register it in Claude Code.</td></tr>`;

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
            <h2>Registered MCP Sites (${status.sites ? status.sites.length : 0})</h2>
            <span class="badge badge-success">Port ${escapeHtml(status.port)} · Authenticated</span>
          </div>
          <div class="primer-box-row">
            <form id="form-add-site" class="form-row">
              <input type="url" name="url" placeholder="https://example.github.io/docs/mcp.html" required style="flex:1;" />
              <input type="text" name="name" placeholder="Optional name (e.g. docs-site)" />
              <button type="submit" class="btn btn-primary" id="btn-add-site">Add &amp; Allow Site</button>
            </form>
          </div>
          <div class="data-table-wrap" style="margin:0;border:none;border-top:1px solid var(--border-default);border-radius:0;">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Page URL</th>
                  <th>Tab Status</th>
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

        <section class="primer-box">
          <div class="primer-box-header">
            <h2>URL Prefix Allowlist (Path-Boundary Matched)</h2>
          </div>
          <div class="primer-box-row">
            <form id="form-allow-prefix" class="form-row">
              <input type="url" name="prefix" placeholder="https://example.github.io/project/" required style="flex:1;" />
              <button type="submit" class="btn" id="btn-allow-prefix">Allow Prefix</button>
            </form>
          </div>
          ${allowlistRows}
        </section>

        <section class="primer-box">
          <div class="primer-box-header">
            <h2><code>/v1</code> Chat Completions Allowed Origins</h2>
            <span class="badge ${openOriginEnabled ? 'badge-warning' : 'badge-readonly'}">
              ${openOriginEnabled ? 'Wildcard (*) Pure Chat Active' : 'Origin-Restricted'}
            </span>
          </div>
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
        </section>

        <section class="primer-box">
          <div class="primer-box-header">
            <h2>Key Management &amp; Rotation</h2>
          </div>
          <div class="primer-box-row form-row">
            <button type="button" class="btn" id="btn-rotate-all-keys">Rotate All Site Keys</button>
            <button type="button" class="btn btn-danger" id="btn-rotate-admin-key">Rotate Admin Key</button>
          </div>
        </section>
      </div>
    `;

    // Wire Add Site
    const addSiteForm = container.querySelector('#form-add-site');
    if (addSiteForm) {
      addSiteForm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const fd = new FormData(addSiteForm);
        const url = String(fd.get('url') || '').trim();
        const name = String(fd.get('name') || '').trim() || undefined;
        try {
          const res = await adminFetch('/admin/v1/sites', {
            method: 'POST',
            body: JSON.stringify({ url, name })
          });
          setFeedback(`Added and allowed site: ${res.site.url}`);
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
  }

  await refreshDashboard();
  return { refreshDashboard };
}
