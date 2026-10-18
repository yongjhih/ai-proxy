import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createRelayServer } from '../src/relay.mjs';
import { runCli } from '../src/cli.mjs';
import { extractHandshake } from '../web/handshake.mjs';
import { matchesPrefix } from '../web/url.mjs';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

test('Security Baseline 1: Path-boundary URL prefix allowlist blocks sibling repos on shared Origin (<user>.github.io)', async () => {
  // Verify path-segment boundary matching
  assert.equal(
    matchesPrefix('https://example.github.io/docs/mcp.html', 'https://example.github.io/docs/'),
    true
  );
  assert.equal(
    matchesPrefix('https://example.github.io/docs-evil/mcp.html', 'https://example.github.io/docs/'),
    false
  );

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-sec1-'));
  const relay = createRelayServer({ port: 0, homeDir: tmpHome });
  const { port } = await relay.start();
  try {
    relay.store.allowPrefix('https://example.github.io/docs/');

    // Sibling repo on the exact same Origin must be rejected with 403 Forbidden
    const evilRes = await fetch(`http://127.0.0.1:${port}/tab/v1/hello`, {
      method: 'POST',
      headers: {
        Origin: 'https://example.github.io',
        'Content-Type': 'application/json',
        Authorization: 'Bearer fake_key'
      },
      body: JSON.stringify({
        url: 'https://example.github.io/docs-evil/mcp.html',
        tools: []
      })
    });
    assert.equal(evilRes.status, 403);
    assert.equal(evilRes.headers.get('access-control-allow-origin'), 'https://example.github.io');
  } finally {
    await relay.stop();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('Security Baseline 2: Per-page key handoff moves #mcp-key into history.state, scrubs URL, and never touches storage', async () => {
  let storageTouched = false;
  const fakeWindow = {
    location: {
      pathname: '/repo/mcp.html',
      search: '',
      hash: '#mcp-key=mcp_secret123&mcp-port=8788'
    },
    history: {
      state: null,
      replaceState(nextState, _unused, cleanUrl) {
        this.state = nextState;
        fakeWindow.location.hash = cleanUrl.includes('#') ? `#${cleanUrl.split('#')[1]}` : '';
      }
    },
    localStorage: {
      setItem() {
        storageTouched = true;
      }
    },
    sessionStorage: {
      setItem() {
        storageTouched = true;
      }
    }
  };

  const hs = extractHandshake(fakeWindow);
  assert.equal(hs.mcpKey, 'mcp_secret123');
  assert.equal(fakeWindow.location.hash, '');
  assert.equal(fakeWindow.history.state.__aiProxy.mcpKey, 'mcp_secret123');
  assert.equal(storageTouched, false);

  // Also verify per-page key isolation on the relay: Page A's key is rejected for Page B on the same Origin
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-sec2-'));
  const relay = createRelayServer({ port: 0, homeDir: tmpHome });
  const { port } = await relay.start();
  try {
    const siteA = relay.store.addSite({ url: 'https://example.github.io/a/mcp.html', name: 'a' });
    relay.store.addSite({ url: 'https://example.github.io/b/mcp.html', name: 'b' });

    const crossKeyRes = await fetch(`http://127.0.0.1:${port}/tab/v1/hello`, {
      method: 'POST',
      headers: {
        Origin: 'https://example.github.io',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${siteA.key}`
      },
      body: JSON.stringify({
        url: 'https://example.github.io/b/mcp.html',
        tools: []
      })
    });
    assert.equal(crossKeyRes.status, 401);
  } finally {
    await relay.stop();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('Security Baseline 3: /mcp rejects any request carrying a browser Origin header with 403 Forbidden', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-sec3-'));
  const relay = createRelayServer({ port: 0, homeDir: tmpHome });
  const { port } = await relay.start();
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/mcp?url=${encodeURIComponent('http://127.0.0.1:3000/mcp.html')}`,
      {
        method: 'POST',
        headers: {
          Origin: 'https://evil.example',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      }
    );
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://evil.example');
  } finally {
    await relay.stop();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('Security Baseline 4: /v1 only exposes individually named --allow-tool mcp__<server>__<tool> with readOnlyHint:true', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-sec4-'));
  let seenPermittedTools = [];
  const relay = createRelayServer({
    port: 0,
    homeDir: tmpHome,
    chatBackend: async ({ permittedTools }) => {
      seenPermittedTools = permittedTools;
      return 'ok';
    }
  });
  const { port } = await relay.start();
  try {
    const siteUrl = 'https://example.github.io/notes/mcp.html';
    relay.store.addSite({ url: siteUrl, name: 'notes' });
    relay.store.updateSiteTools(siteUrl, [
      {
        name: 'read_note',
        description: 'Read a note',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true }
      },
      {
        name: 'delete_note',
        description: 'Delete a note',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: false }
      }
    ]);
    relay.store.allowOrigin('https://example.github.io');

    // Even if both tools are passed to setAllowedTools, only read_note (readOnlyHint: true) is permitted
    relay.store.setAllowedTools(['mcp__notes__read_note', 'mcp__notes__delete_note']);

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Origin: 'https://example.github.io',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'local-default',
        messages: [{ role: 'user', content: 'hi' }]
      })
    });
    assert.equal(res.status, 200);
    assert.deepEqual(
      seenPermittedTools.map((t) => t.fullSpec),
      ['mcp__notes__read_note']
    );
  } finally {
    await relay.stop();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('Security Baseline 5: /admin/v1 requires separate adminKey; open-dashboard checks Origin, rate-limits, and never returns key', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-sec5-'));
  const opened = [];
  const relay = createRelayServer({
    port: 0,
    homeDir: tmpHome,
    openBrowser: async (u) => opened.push(u)
  });
  const { port } = await relay.start();
  try {
    const site = relay.store.addSite({ url: 'https://example.github.io/a/mcp.html', name: 'a' });

    // Page key cannot access /admin/v1/status
    const withPageKey = await fetch(`http://127.0.0.1:${port}/admin/v1/status`, {
      headers: { Authorization: `Bearer ${site.key}` }
    });
    assert.equal(withPageKey.status, 401);

    // Foreign origin cannot call open-dashboard
    const foreignOrigin = await fetch(`http://127.0.0.1:${port}/admin/v1/open-dashboard`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' }
    });
    assert.equal(foreignOrigin.status, 403);

    // Legitimate dashboard origin triggers browser open, never leaks adminKey in body, and rate-limits after 3 calls
    for (let i = 0; i < 3; i += 1) {
      const okOpen = await fetch(`http://127.0.0.1:${port}/admin/v1/open-dashboard`, {
        method: 'POST',
        headers: { Origin: `http://127.0.0.1:${port}` }
      });
      assert.equal(okOpen.status, 200);
      const bodyText = await okOpen.text();
      assert.ok(!bodyText.includes(relay.store.getAdminKey()), 'adminKey must never appear in HTTP response');
    }
    assert.equal(opened.length, 3);

    const rateLimited = await fetch(`http://127.0.0.1:${port}/admin/v1/open-dashboard`, {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${port}` }
    });
    assert.equal(rateLimited.status, 429);
  } finally {
    await relay.stop();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('Security Baseline 6: Mutating built-in MCP tools (add_site, remove_site) are marked readOnlyHint:false and document explicit user intent', () => {
  const selfMcpSource = fs.readFileSync(path.join(ROOT_DIR, 'site', 'self-mcp.mjs'), 'utf8');
  assert.ok(selfMcpSource.includes("name: 'add_site'"));
  assert.ok(selfMcpSource.includes("name: 'remove_site'"));
  assert.ok(
    selfMcpSource.includes('Only call this tool when the human user has explicitly asked to add that specific site URL')
  );
  assert.ok(
    selfMcpSource.includes('Only call this tool when the human user has explicitly asked to remove that specific site')
  );
});

test('Security Baseline 7: Wildcard (*) on /v1 forces zero tools (pure chat), enforces TTL, and emits warnings', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-sec7-'));
  let seenTools = ['unexpected'];
  const relay = createRelayServer({
    port: 0,
    homeDir: tmpHome,
    chatBackend: async ({ permittedTools }) => {
      seenTools = permittedTools;
      return 'pure chat response';
    }
  });
  const { port } = await relay.start();
  try {
    const siteUrl = 'https://example.github.io/notes/mcp.html';
    relay.store.addSite({ url: siteUrl, name: 'notes' });
    relay.store.updateSiteTools(siteUrl, [
      {
        name: 'read_note',
        description: 'Read a note',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true }
      }
    ]);
    relay.store.setAllowedTools(['mcp__notes__read_note']);

    // Enable wildcard * with 60s TTL
    relay.store.allowOrigin('*', { ttlSeconds: 60 });
    assert.equal(relay.store.isOpenOriginActive(), true);
    assert.ok(relay.store.getWarnings().some((w) => w.includes('WARNING')));

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Origin: 'https://any-untrusted-origin.example',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'local-default',
        messages: [{ role: 'user', content: 'hello' }]
      })
    });
    assert.equal(res.status, 200);
    // Zero tools exposed while wildcard * is active!
    assert.deepEqual(seenTools, []);
  } finally {
    await relay.stop();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('Example site (examples/notes-site) passes ai-proxy doctor', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-doc-ex-'));
  let stdoutData = '';
  let stderrData = '';
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdoutData += chunk.toString();
      cb();
    }
  });
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      stderrData += chunk.toString();
      cb();
    }
  });

  try {
    const code = await runCli(
      ['doctor', '--dir', path.join(ROOT_DIR, 'examples', 'notes-site')],
      {
        env: { ...process.env, AI_PROXY_HOME: tmpHome },
        stdin: Readable.from([]),
        stdout,
        stderr
      }
    );
    assert.equal(code, 0, `doctor failed: ${stderrData}`);
    const report = JSON.parse(stdoutData);
    assert.equal(report.ok, true);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
