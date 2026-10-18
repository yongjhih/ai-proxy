import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePageUrl,
  matchesPrefix,
  isLocalhostUrl,
  isAllowedPageUrl,
  parseMcpRouteUrl,
  resolveMcpEndpoint
} from '../web/url.mjs';

test('normalizePageUrl strips query, hash, credentials, default ports, and normalizes index.html', () => {
  assert.equal(
    normalizePageUrl('HTTPS://Example.GitHub.io:443/org/repo/mcp.html?tool=about#mcp-key=secret'),
    'https://example.github.io/org/repo/mcp.html'
  );
  assert.equal(
    normalizePageUrl('http://user:pass@localhost:80/app//sub/../index.html?x=1#hash'),
    'http://localhost/app/'
  );
  assert.equal(
    normalizePageUrl('https://example.github.io/org/repo'),
    'https://example.github.io/org/repo'
  );
  assert.throws(() => normalizePageUrl('javascript:alert(1)'), /Unsupported protocol/i);
  assert.throws(() => normalizePageUrl('file:///etc/passwd'), /Unsupported protocol/i);
});

test('matchesPrefix enforces strict path segment boundaries on shared origins (*.github.io)', () => {
  const allowed = 'https://example.github.io/my-app';

  // Exact and child paths match
  assert.equal(matchesPrefix('https://example.github.io/my-app', allowed), true);
  assert.equal(matchesPrefix('https://example.github.io/my-app/', allowed), true);
  assert.equal(matchesPrefix('https://example.github.io/my-app/mcp.html', allowed), true);
  assert.equal(matchesPrefix('https://example.github.io/my-app/nested/mcp', allowed), true);

  // Sibling repos and prefix-lookalikes on the SAME origin MUST NOT match
  assert.equal(matchesPrefix('https://example.github.io/my-app-evil', allowed), false);
  assert.equal(matchesPrefix('https://example.github.io/my-app-evil/mcp.html', allowed), false);
  assert.equal(matchesPrefix('https://example.github.io/other-repo/mcp.html', allowed), false);
  assert.equal(matchesPrefix('https://example.github.io/', allowed), false);

  // Different scheme or port or host MUST NOT match
  assert.equal(matchesPrefix('http://example.github.io/my-app/mcp.html', allowed), false);
  assert.equal(matchesPrefix('https://evil.github.io/my-app/mcp.html', allowed), false);
});

test('matchesPrefix with trailing slash in allowed prefix', () => {
  const allowed = 'https://example.github.io/my-app/';
  assert.equal(matchesPrefix('https://example.github.io/my-app', allowed), true);
  assert.equal(matchesPrefix('https://example.github.io/my-app/', allowed), true);
  assert.equal(matchesPrefix('https://example.github.io/my-app/mcp.html', allowed), true);
  assert.equal(matchesPrefix('https://example.github.io/my-app2/mcp.html', allowed), false);
});

test('isLocalhostUrl identifies localhost, 127.0.0.1, and [::1]', () => {
  assert.equal(isLocalhostUrl('http://localhost:3000/mcp.html'), true);
  assert.equal(isLocalhostUrl('http://127.0.0.1:8788/dashboard/'), true);
  assert.equal(isLocalhostUrl('http://[::1]:8080/mcp'), true);
  assert.equal(isLocalhostUrl('https://localhost.evil.com/mcp'), false);
  assert.equal(isLocalhostUrl('https://example.github.io/localhost'), false);
});

test('isAllowedPageUrl allows localhost automatically and checks prefix list for remote URLs', () => {
  const allowlist = ['https://example.github.io/docs/'];
  assert.equal(isAllowedPageUrl('http://127.0.0.1:5173/mcp.html', []), true);
  assert.equal(isAllowedPageUrl('http://localhost:8080/mcp.html', []), true);
  assert.equal(isAllowedPageUrl('https://example.github.io/docs/mcp.html', allowlist), true);
  assert.equal(isAllowedPageUrl('https://example.github.io/evil/mcp.html', allowlist), false);
});

test('parseMcpRouteUrl resolves both /mcp?url=... and /mcp/<host>/<path>', () => {
  assert.equal(
    parseMcpRouteUrl('/mcp?url=https%3A%2F%2Fexample.github.io%2Fdocs%2Fmcp.html'),
    'https://example.github.io/docs/mcp.html'
  );
  assert.equal(
    parseMcpRouteUrl('/mcp/example.github.io/docs/mcp.html'),
    'https://example.github.io/docs/mcp.html'
  );
  assert.equal(
    parseMcpRouteUrl('/mcp/localhost:4000/mcp.html'),
    'http://localhost:4000/mcp.html'
  );
  assert.equal(
    parseMcpRouteUrl('/mcp/127.0.0.1:8788/mcp.html'),
    'http://127.0.0.1:8788/mcp.html'
  );
  assert.equal(parseMcpRouteUrl('/mcp'), null);
});

test('resolveMcpEndpoint auto-resolves /mcp or /mcp.html and preserves explicit endpoints', async () => {
  // 1. Explicit /mcp or .html is kept as-is without probe
  assert.equal(
    await resolveMcpEndpoint('https://example.github.io/app/mcp'),
    'https://example.github.io/app/mcp'
  );
  assert.equal(
    await resolveMcpEndpoint('https://example.github.io/app/mcp.html'),
    'https://example.github.io/app/mcp.html'
  );

  // 2. Directory URL with mock fetch returning 200 for /mcp
  const mockFetchMcp = async (url) => {
    if (url === 'https://example.github.io/docs/mcp') return { ok: true, status: 200 };
    return { ok: false, status: 404 };
  };
  assert.equal(
    await resolveMcpEndpoint('https://example.github.io/docs/', { fetchFn: mockFetchMcp }),
    'https://example.github.io/docs/mcp'
  );

  // 3. Directory URL with mock fetch returning 404 for /mcp but 200 for /mcp.html
  const mockFetchHtml = async (url) => {
    if (url === 'https://example.github.io/notes/mcp.html') return { ok: true, status: 200 };
    return { ok: false, status: 404 };
  };
  assert.equal(
    await resolveMcpEndpoint('https://example.github.io/notes', { fetchFn: mockFetchHtml }),
    'https://example.github.io/notes/mcp.html'
  );

  // 4. Fallback to /mcp when neither responds 200 or fetch throws
  const mockFailingFetch = async () => {
    throw new Error('network down');
  };
  assert.equal(
    await resolveMcpEndpoint('https://example.github.io/offline/', { fetchFn: mockFailingFetch }),
    'https://example.github.io/offline/mcp'
  );
});

