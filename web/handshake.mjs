/**
 * Safe URL fragment key extraction into history.state.
 * Never touches localStorage, sessionStorage, IndexedDB, or cookies.
 */

const STATE_NAMESPACE = '__aiProxy';

export function extractHandshake(win = globalThis.window) {
  if (!win || !win.location || !win.history) {
    return { mcpKey: null, mcpPort: 8788, adminKey: null };
  }

  const existingState =
    win.history.state && typeof win.history.state === 'object' ? win.history.state : {};
  const saved =
    existingState[STATE_NAMESPACE] && typeof existingState[STATE_NAMESPACE] === 'object'
      ? existingState[STATE_NAMESPACE]
      : {};

  let mcpKey = typeof saved.mcpKey === 'string' && saved.mcpKey ? saved.mcpKey : null;
  let mcpPort =
    Number.isInteger(saved.mcpPort) && saved.mcpPort > 0 && saved.mcpPort <= 65535
      ? saved.mcpPort
      : 8788;
  let adminKey = typeof saved.adminKey === 'string' && saved.adminKey ? saved.adminKey : null;

  const rawHash = win.location.hash ? win.location.hash.replace(/^#/, '') : '';
  if (rawHash && (rawHash.includes('mcp-key=') || rawHash.includes('mcp-port=') || rawHash.includes('admin-key='))) {
    const params = new URLSearchParams(rawHash);
    let mutated = false;

    if (params.has('mcp-key')) {
      const k = params.get('mcp-key');
      if (k) mcpKey = k;
      params.delete('mcp-key');
      mutated = true;
    }

    if (params.has('mcp-port')) {
      const p = Number.parseInt(params.get('mcp-port') || '', 10);
      if (Number.isInteger(p) && p > 0 && p <= 65535) {
        mcpPort = p;
      }
      params.delete('mcp-port');
      mutated = true;
    }

    if (params.has('admin-key')) {
      const ak = params.get('admin-key');
      if (ak) adminKey = ak;
      params.delete('admin-key');
      mutated = true;
    }

    if (mutated) {
      const nextState = {
        ...existingState,
        [STATE_NAMESPACE]: {
          mcpKey,
          mcpPort,
          adminKey
        }
      };
      const remainingHash = params.toString();
      const cleanUrl = `${win.location.pathname}${win.location.search}${remainingHash ? `#${remainingHash}` : ''}`;
      win.history.replaceState(nextState, '', cleanUrl);
    }
  }

  return { mcpKey, mcpPort, adminKey };
}
