/**
 * Page URL normalization, prefix matching, and localhost detection for MCP Pages.
 * Zero-dependency ES module suitable for both browser tabs and Node.js relay.
 */

export function normalizePageUrl(rawUrl, baseUrl = undefined) {
  if (!rawUrl || (typeof rawUrl !== 'string' && !(rawUrl instanceof URL))) {
    throw new TypeError('Invalid URL: expected non-empty string or URL');
  }
  const parsed = new URL(String(rawUrl), baseUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`Unsupported protocol: ${parsed.protocol}`);
  }

  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';

  // Collapse duplicate slashes in pathname
  let pathname = parsed.pathname.replace(/\/{2,}/g, '/');
  if (pathname.endsWith('/index.html')) {
    pathname = pathname.slice(0, -'index.html'.length);
  }
  parsed.pathname = pathname || '/';

  return parsed.toString();
}

export function isLocalhostUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

export function matchesPrefix(targetUrl, allowedPrefix) {
  let target;
  let prefix;
  try {
    target = new URL(normalizePageUrl(targetUrl));
    prefix = new URL(normalizePageUrl(allowedPrefix));
  } catch {
    return false;
  }

  if (target.origin !== prefix.origin) {
    return false;
  }

  const targetPath = target.pathname;
  const prefixPath = prefix.pathname;

  if (prefixPath === '/') {
    return true;
  }

  const cleanPrefix = prefixPath.endsWith('/') ? prefixPath.slice(0, -1) : prefixPath;
  const cleanTarget = targetPath.endsWith('/') ? targetPath.slice(0, -1) : targetPath;

  if (cleanTarget === cleanPrefix) {
    return true;
  }

  return targetPath.startsWith(`${cleanPrefix}/`);
}

export function isAllowedPageUrl(targetUrl, allowlist = []) {
  try {
    const normalized = normalizePageUrl(targetUrl);
    if (isLocalhostUrl(normalized)) {
      return true;
    }
    for (const prefix of allowlist) {
      if (matchesPrefix(normalized, prefix)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function parseMcpRouteUrl(reqUrl) {
  try {
    const parsed = new URL(reqUrl, 'http://127.0.0.1');
    if (parsed.pathname === '/mcp' || parsed.pathname === '/mcp/') {
      const queryUrl = parsed.searchParams.get('url');
      if (!queryUrl) return null;
      return normalizePageUrl(queryUrl);
    }
    if (parsed.pathname.startsWith('/mcp/')) {
      const rest = parsed.pathname.slice('/mcp/'.length);
      if (!rest) return null;
      const slashIdx = rest.indexOf('/');
      const hostPart = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
      const pathPart = slashIdx === -1 ? '/' : rest.slice(slashIdx);
      if (!hostPart) return null;
      const hostOnly = hostPart.split(':')[0].toLowerCase();
      const isLocal = hostOnly === 'localhost' || hostOnly === '127.0.0.1' || hostOnly === '[::1]';
      const scheme = isLocal ? 'http://' : 'https://';
      return normalizePageUrl(`${scheme}${hostPart}${pathPart}`);
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolveMcpEndpoint(inputUrl, { fetchFn = globalThis.fetch } = {}) {
  let clean = String(inputUrl || '').trim();
  if (!clean) return clean;
  if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
    clean = `https://${clean}`;
  }
  let parsed;
  try {
    parsed = new URL(clean);
  } catch {
    return clean;
  }

  // Strip trailing slashes
  let pathname = parsed.pathname.replace(/\/+$/, '');
  // If user already specified an endpoint ending in /mcp or an extension like .html
  if (pathname.endsWith('/mcp') || pathname.endsWith('.html')) {
    parsed.pathname = pathname;
    return parsed.toString();
  }

  const base = `${parsed.origin}${pathname}`;
  const candidateMcp = `${base}/mcp`;
  const candidateHtml = `${base}/mcp.html`;

  if (typeof fetchFn === 'function') {
    // 1. Try HEAD /mcp
    try {
      const res = await fetchFn(candidateMcp, {
        method: 'HEAD',
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(600) : undefined
      });
      if (res && (res.status === 200 || res.ok)) {
        return candidateMcp;
      }
    } catch {}

    // 2. Try HEAD /mcp.html
    try {
      const res = await fetchFn(candidateHtml, {
        method: 'HEAD',
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(600) : undefined
      });
      if (res && (res.status === 200 || res.ok)) {
        return candidateHtml;
      }
    } catch {}
  }

  // Default fallback: candidateMcp
  return candidateMcp;
}
