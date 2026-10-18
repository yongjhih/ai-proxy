/**
 * Reference MCP Page UI and ?tool= direct read-only execution handler.
 */

import { extractHandshake } from './handshake.mjs';
import { installModelContext } from './model-context.mjs';
import { createTabClient } from './client.mjs';

export function parseQueryToolParams(searchString, toolSchema) {
  const params = new URLSearchParams(searchString.startsWith('?') ? searchString.slice(1) : searchString);
  const toolName = params.get('tool');
  if (!toolName) return null;

  if (params.has('input')) {
    try {
      return {
        toolName,
        args: JSON.parse(params.get('input'))
      };
    } catch {
      return { toolName, args: {} };
    }
  }

  const args = {};
  const props =
    toolSchema && toolSchema.properties && typeof toolSchema.properties === 'object'
      ? toolSchema.properties
      : {};

  for (const [key, value] of params.entries()) {
    if (key === 'tool') continue;
    const propType = props[key] && props[key].type;
    if (propType === 'number' || propType === 'integer') {
      const n = Number(value);
      args[key] = Number.isNaN(n) ? value : n;
    } else if (propType === 'boolean') {
      args[key] = value === 'true' || value === '1';
    } else if (propType === 'array' || propType === 'object') {
      try {
        args[key] = JSON.parse(value);
      } catch {
        args[key] = value;
      }
    } else {
      args[key] = value;
    }
  }

  return { toolName, args };
}

export async function executeDirectToolQuery(modelContext, searchString = '') {
  const rawParams = new URLSearchParams(searchString.startsWith('?') ? searchString.slice(1) : searchString);
  const toolName = rawParams.get('tool');
  if (!toolName) {
    return { requested: false, executed: false };
  }

  const tool = modelContext.getTool(toolName);
  if (!tool) {
    return {
      requested: true,
      executed: false,
      toolName,
      error: `Unknown tool "${toolName}"`
    };
  }

  if (!tool.annotations || tool.annotations.readOnlyHint !== true) {
    return {
      requested: true,
      executed: false,
      toolName,
      error: `Tool "${toolName}" is not read-only (readOnlyHint: false) and cannot be auto-executed via ?tool= query parameter.`
    };
  }

  const parsed = parseQueryToolParams(searchString, tool.inputSchema);
  try {
    const output = await modelContext.callTool(toolName, parsed ? parsed.args : {});
    return {
      requested: true,
      executed: true,
      toolName,
      args: parsed ? parsed.args : {},
      output
    };
  } catch (err) {
    return {
      requested: true,
      executed: false,
      toolName,
      error: err && err.message ? err.message : String(err)
    };
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function mountMcpPageUi({
  container,
  title = 'MCP Page',
  tools = [],
  win = globalThis.window
} = {}) {
  const handshake = extractHandshake(win);
  const modelContext = installModelContext(win && win.navigator);

  for (const t of tools) {
    modelContext.registerTool(t);
  }

  const directResult = await executeDirectToolQuery(
    modelContext,
    win && win.location ? win.location.search : ''
  );

  function renderCatalog(clientState) {
    if (!container) return;
    const registered = modelContext.listTools();
    const statusBadge =
      clientState.status === 'connected'
        ? `<span class="badge badge-success" data-status="connected">Connected (${escapeHtml(clientState.sessionId || '')})</span>`
        : clientState.status === 'awaiting-key'
          ? `<span class="badge badge-warning" data-status="awaiting-key">ai-proxy detected (standalone tab — no key)</span>`
          : clientState.status === 'rejected'
            ? `<span class="badge badge-danger" data-status="rejected">Rejected: ${escapeHtml(clientState.error || '')}</span>`
            : `<span class="badge badge-neutral" data-status="${escapeHtml(clientState.status)}">${escapeHtml(clientState.status)}</span>`;

    const directBlock = directResult.requested
      ? `<section class="mcp-direct-result" id="mcp-direct-result" data-tool="${escapeHtml(directResult.toolName || '')}">
          <h3>Direct Query Result (<code>?tool=${escapeHtml(directResult.toolName || '')}</code>)</h3>
          ${
            directResult.executed
              ? `<pre class="mcp-output" id="mcp-direct-output">${escapeHtml(
                  typeof directResult.output === 'string'
                    ? directResult.output
                    : JSON.stringify(directResult.output, null, 2)
                )}</pre>`
              : `<div class="mcp-alert mcp-alert-warning" id="mcp-direct-error">${escapeHtml(directResult.error || '')}</div>`
          }
        </section>`
      : '';

    const toolCards = registered
      .map((t) => {
        const ro = t.annotations && t.annotations.readOnlyHint === true;
        const props =
          t.inputSchema && t.inputSchema.properties ? Object.entries(t.inputSchema.properties) : [];
        const inputsHtml = props
          .map(([k, schema]) => {
            const req = Array.isArray(t.inputSchema.required) && t.inputSchema.required.includes(k);
            return `<label class="mcp-field">
              <span><code>${escapeHtml(k)}</code> (${escapeHtml(schema.type || 'string')}${req ? ' *' : ''})</span>
              <input type="text" name="${escapeHtml(k)}" data-prop-type="${escapeHtml(schema.type || 'string')}" placeholder="${escapeHtml(schema.description || '')}" />
            </label>`;
          })
          .join('');

        return `<div class="mcp-tool-row" data-tool-name="${escapeHtml(t.name)}">
          <div class="mcp-tool-header">
            <h4 class="mcp-tool-title"><code>${escapeHtml(t.name)}</code></h4>
            <span class="badge ${ro ? 'badge-readonly' : 'badge-mutating'}">${
              ro ? 'Read-Only' : 'Mutating (Requires Confirmation)'
            }</span>
          </div>
          <p class="mcp-tool-desc">${escapeHtml(t.description)}</p>
          <form class="mcp-tool-form" data-tool="${escapeHtml(t.name)}">
            ${inputsHtml ? `<div class="mcp-field-group">${inputsHtml}</div>` : ''}
            <div class="mcp-tool-actions">
              <button type="submit" class="btn btn-sm">Run Tool</button>
              ${
                ro
                  ? `<a class="btn-link" href="?tool=${encodeURIComponent(t.name)}">Direct Link (?tool=${escapeHtml(t.name)})</a>`
                  : ''
              }
            </div>
            <pre class="mcp-tool-result" hidden></pre>
          </form>
        </div>`;
      })
      .join('');

    container.innerHTML = `
      <div class="mcp-page-widget">
        <div class="mcp-status-bar">
          <div><strong>MCP Relay Status:</strong> ${statusBadge}</div>
          <div class="mcp-port-meta">Port: <code>${escapeHtml(handshake.mcpPort)}</code></div>
        </div>
        ${directBlock}
        <section class="mcp-catalog">
          <h3>Registered WebMCP Tools (${registered.length})</h3>
          <div class="mcp-tool-list">${toolCards}</div>
        </section>
      </div>
    `;

    for (const form of container.querySelectorAll('.mcp-tool-form')) {
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const tName = form.getAttribute('data-tool');
        const outEl = form.querySelector('.mcp-tool-result');
        const args = {};
        for (const input of form.querySelectorAll('input[name]')) {
          const val = input.value.trim();
          if (!val) continue;
          const pType = input.getAttribute('data-prop-type');
          if (pType === 'number' || pType === 'integer') {
            args[input.name] = Number(val);
          } else if (pType === 'boolean') {
            args[input.name] = val === 'true' || val === '1';
          } else {
            args[input.name] = val;
          }
        }
        if (outEl) {
          outEl.hidden = false;
          outEl.textContent = 'Running...';
          try {
            const res = await modelContext.callTool(tName, args);
            outEl.textContent =
              typeof res === 'string' ? res : JSON.stringify(res, null, 2);
          } catch (err) {
            outEl.textContent = `Error: ${err && err.message ? err.message : String(err)}`;
          }
        }
      });
    }
  }

  const pageUrl = win && win.location ? win.location.href : 'http://localhost/mcp.html';
  const client = createTabClient({
    url: pageUrl,
    title,
    mcpKey: handshake.mcpKey,
    mcpPort: handshake.mcpPort,
    modelContext,
    onStateChange(st) {
      renderCatalog(st);
    }
  });

  renderCatalog(client.getState());
  try {
    await client.start();
  } catch {
    renderCatalog(client.getState());
  }

  return {
    handshake,
    modelContext,
    client,
    directResult
  };
}
