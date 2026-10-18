import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRelayServer } from '../src/relay.mjs';
import { createStore } from '../src/store.mjs';
import { createModelContext } from '../web/model-context.mjs';
import { createTabClient } from '../web/client.mjs';

function makeTempConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-test-'));
}

test('Relay end-to-end with fake tab: multi-client ID rewriting, idle wake-up, and /mcp path & query routes', async (t) => {
  const configDir = makeTempConfigDir();
  const store = createStore({ configDir });
  const pageUrl = 'https://example.github.io/docs/mcp.html';
  store.allowPrefix('https://example.github.io/docs/');
  const pageKey = store.getOrCreatePageKey(pageUrl);

  const relay = createRelayServer({
    store,
    port: 0,
    pollTimeoutMs: 2000,
    reconnectGraceMs: 50,
    connectTimeoutMs: 1000,
    execTimeoutMs: 1000
  });
  const { port } = await relay.start();
  t.after(async () => {
    await relay.stop();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  // Set up fake browser tab with ModelContext
  const mc = createModelContext();
  const seenRpcIdsInTab = [];
  mc.registerTool({
    name: 'slow_echo',
    description: 'Echoes input after delay',
    inputSchema: {
      type: 'object',
      properties: {
        clientName: { type: 'string' },
        delayMs: { type: 'integer' }
      },
      required: ['clientName', 'delayMs']
    },
    annotations: { readOnlyHint: true },
    async execute({ clientName, delayMs }) {
      await new Promise((r) => setTimeout(r, delayMs));
      return { echoedFor: clientName };
    }
  });

  // Intercept tab fetches to record the rewritten JSON-RPC IDs sent by relay
  const wrappedFetch = async (url, init) => {
    const res = await fetch(url, init);
    if (String(url).includes('/tab/v1/poll') && res.status === 200) {
      const cloned = res.clone();
      const body = await cloned.json();
      if (body && body.rpc) {
        seenRpcIdsInTab.push(body.rpc.id);
      }
    }
    return res;
  };

  const tabClient = createTabClient({
    url: pageUrl,
    title: 'Docs Tab',
    mcpKey: pageKey,
    mcpPort: port,
    modelContext: mc,
    fetchImpl: wrappedFetch
  });

  await tabClient.start();
  t.after(() => tabClient.stop());

  // Wait briefly so the tab is parked in idle long-polling
  await new Promise((r) => setTimeout(r, 40));

  // Two MCP clients send concurrent requests with the EXACT SAME JSON-RPC id: 1
  const clientA = fetch(`http://127.0.0.1:${port}/mcp?url=${encodeURIComponent(pageUrl)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'slow_echo', arguments: { clientName: 'ClientA', delayMs: 40 } }
    })
  }).then((r) => r.json());

  const clientB = fetch(`http://127.0.0.1:${port}/mcp/example.github.io/docs/mcp.html`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'slow_echo', arguments: { clientName: 'ClientB', delayMs: 10 } }
    })
  }).then((r) => r.json());

  const [resA, resB] = await Promise.all([clientA, clientB]);

  // Both clients receive their own original id: 1 and their own payload!
  assert.equal(resA.id, 1);
  assert.equal(resB.id, 1);
  assert.deepEqual(JSON.parse(resA.result.content[0].text), { echoedFor: 'ClientA' });
  assert.deepEqual(JSON.parse(resB.result.content[0].text), { echoedFor: 'ClientB' });

  // Inside the tab, the two JSON-RPC ids were rewritten to distinct callIds
  assert.equal(seenRpcIdsInTab.length, 2);
  assert.notEqual(seenRpcIdsInTab[0], seenRpcIdsInTab[1]);
  assert.notEqual(seenRpcIdsInTab[0], 1);
});

test('Relay reconnect grace period and 409 Conflict re-hello recovery without opening duplicate tab', async (t) => {
  const configDir = makeTempConfigDir();
  const store = createStore({ configDir });
  const pageUrl = 'https://example.github.io/app/mcp.html';
  store.allowPrefix('https://example.github.io/app/');
  const pageKey = store.getOrCreatePageKey(pageUrl);

  let browserOpenCount = 0;
  const relay = createRelayServer({
    store,
    port: 0,
    pollTimeoutMs: 1000,
    reconnectGraceMs: 250,
    connectTimeoutMs: 1000,
    execTimeoutMs: 1000,
    openBrowser: async () => {
      browserOpenCount += 1;
    }
  });
  const { port } = await relay.start();
  t.after(async () => {
    await relay.stop();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  // 1. Verify stale sessionId receives 409 Conflict with CORS headers
  const stalePoll = await fetch(`http://127.0.0.1:${port}/tab/v1/poll?sessionId=ses_stale_old`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${pageKey}`,
      Origin: 'https://example.github.io'
    }
  });
  assert.equal(stalePoll.status, 409);
  assert.equal(stalePoll.headers.get('access-control-allow-origin'), 'https://example.github.io');

  // 2. Start an MCP request BEFORE the tab connects; tab connects 60ms later (within 250ms grace window)
  const mc = createModelContext();
  mc.registerTool({
    name: 'ping_app',
    description: 'Returns pong',
    annotations: { readOnlyHint: true },
    async execute() {
      return { pong: true };
    }
  });

  const tabClient = createTabClient({
    url: pageUrl,
    title: 'App Tab',
    mcpKey: pageKey,
    mcpPort: port,
    modelContext: mc
  });
  t.after(() => tabClient.stop());

  const mcpCallPromise = fetch(`http://127.0.0.1:${port}/mcp?url=${encodeURIComponent(pageUrl)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'ping_app', arguments: {} }
    })
  }).then((r) => r.json());

  setTimeout(() => {
    tabClient.start();
  }, 60);

  const mcpReply = await mcpCallPromise;
  assert.equal(mcpReply.id, 99);
  assert.deepEqual(JSON.parse(mcpReply.result.content[0].text), { pong: true });
  assert.equal(browserOpenCount, 0, 'Should NOT have opened a new browser tab when existing tab reconnected within grace period');
});

test('Relay enforces queue limit (-32000) and call timeout (-32001)', async (t) => {
  const configDir = makeTempConfigDir();
  const store = createStore({ configDir });
  const pageUrl = 'https://example.github.io/timeout-app/mcp.html';
  store.allowPrefix('https://example.github.io/timeout-app/');

  const relay = createRelayServer({
    store,
    port: 0,
    maxQueueSize: 2,
    reconnectGraceMs: 30,
    connectTimeoutMs: 120,
    execTimeoutMs: 120,
    openBrowser: async () => {}
  });
  const { port } = await relay.start();
  t.after(async () => {
    await relay.stop();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  const sendCall = (id) =>
    fetch(`http://127.0.0.1:${port}/mcp?url=${encodeURIComponent(pageUrl)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/list',
        params: {}
      })
    }).then((r) => r.json());

  // Fire 3 concurrent calls when maxQueueSize is 2 and no tab connects
  const [r1, r2, r3] = await Promise.all([sendCall(1), sendCall(2), sendCall(3)]);

  // The 3rd call must be rejected immediately with queue full (-32000)
  assert.equal(r3.id, 3);
  assert.equal(r3.error.code, -32000);
  assert.match(r3.error.message, /queue full/i);

  // The first 2 calls time out waiting for tab (-32001)
  assert.equal(r1.error.code, -32001);
  assert.equal(r2.error.code, -32001);
});

test('Relay enforces all security rejection paths, Claude Code quirks, and CORS / LNA headers', async (t) => {
  const configDir = makeTempConfigDir();
  const store = createStore({ configDir });
  const goodUrl = 'https://example.github.io/good-repo/mcp.html';
  const evilSiblingUrl = 'https://example.github.io/good-repo-evil/mcp.html';
  store.allowPrefix('https://example.github.io/good-repo');
  const goodKey = store.getOrCreatePageKey(goodUrl);

  const relay = createRelayServer({ store, port: 0 });
  const { port } = await relay.start();
  t.after(async () => {
    await relay.stop();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  // 1. Rule 3: /mcp rejects any request carrying an Origin header (403)
  const originMcpRes = await fetch(`http://127.0.0.1:${port}/mcp?url=${encodeURIComponent(goodUrl)}`, {
    method: 'POST',
    headers: {
      Origin: 'https://example.github.io',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
  });
  assert.equal(originMcpRes.status, 403);

  // 2. Claude Code GET /mcp SSE probe -> 405 Method Not Allowed
  const getSseRes = await fetch(`http://127.0.0.1:${port}/mcp?url=${encodeURIComponent(goodUrl)}`, {
    method: 'GET'
  });
  assert.equal(getSseRes.status, 405);
  assert.equal(getSseRes.headers.get('allow'), 'POST');

  // 3. Claude Code server/discover probe -> -32601
  const discoverRes = await fetch(`http://127.0.0.1:${port}/mcp?url=${encodeURIComponent(goodUrl)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'server/discover', params: {} })
  }).then((r) => r.json());
  assert.equal(discoverRes.id, 10);
  assert.equal(discoverRes.error.code, -32601);

  // 4. Rule 2: Sibling repo on same origin rejected by path-boundary prefix allowlist (403)
  const evilMcpRes = await fetch(`http://127.0.0.1:${port}/mcp?url=${encodeURIComponent(evilSiblingUrl)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
  });
  assert.equal(evilMcpRes.status, 403);

  // 5. Rule 1 & CORS on rejection: Wrong key on /tab/v1/hello returns 401 WITH CORS headers
  const badKeyRes = await fetch(`http://127.0.0.1:${port}/tab/v1/hello`, {
    method: 'POST',
    headers: {
      Origin: 'https://example.github.io',
      Authorization: 'Bearer wrong_key',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ url: goodUrl, title: 'Test', tools: [] })
  });
  assert.equal(badKeyRes.status, 401);
  assert.equal(badKeyRes.headers.get('access-control-allow-origin'), 'https://example.github.io');
  assert.equal(badKeyRes.headers.get('access-control-allow-private-network'), 'true');

  // 6. Cross-page key reuse blocked: goodKey cannot authenticate another localhost page
  const crossPageRes = await fetch(`http://127.0.0.1:${port}/tab/v1/hello`, {
    method: 'POST',
    headers: {
      Origin: 'http://localhost:3000',
      Authorization: `Bearer ${goodKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ url: 'http://localhost:3000/mcp.html', title: 'Other', tools: [] })
  });
  assert.equal(crossPageRes.status, 401);

  // 7. Chrome Local Network Access OPTIONS preflight
  const preflightRes = await fetch(`http://127.0.0.1:${port}/tab/v1/hello`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://example.github.io',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Private-Network': 'true'
    }
  });
  assert.equal(preflightRes.status, 204);
  assert.equal(preflightRes.headers.get('access-control-allow-origin'), 'https://example.github.io');
  assert.equal(preflightRes.headers.get('access-control-allow-private-network'), 'true');
});

test('Relay enforces site read/write permissions: defaults to true, toggleable, and blocks mutating tools on read-only mode', async (t) => {
  const configDir = makeTempConfigDir();
  const store = createStore({ configDir });

  // 1. Add site defaults to write: true
  const site1 = store.addSite({ url: 'https://example.github.io/my-docs/mcp', name: 'my-docs' });
  assert.equal(site1.write, true, 'New site must default to write: true');

  // Update site tools: 1 read-only tool, 1 mutating tool
  store.updateSiteTools(site1.url, [
    {
      name: 'get_info',
      description: 'Read-only tool',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true }
    },
    {
      name: 'create_item',
      description: 'Mutating tool',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: false }
    }
  ]);

  const relay = createRelayServer({ store, port: 0 });
  const { port } = await relay.start();
  t.after(async () => {
    await relay.stop();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  const adminKey = store.getAdminKey();

  // 2. Toggle to read-only via /admin/v1/sites/permission
  const permRes = await fetch(`http://127.0.0.1:${port}/admin/v1/sites/permission`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ url: site1.url, write: false })
  }).then((r) => r.json());
  assert.equal(permRes.ok, true);
  assert.equal(permRes.site.write, false);

  // 3. Mutating tool call on read-only site is blocked with -32602
  const mutateRes = await fetch(`http://127.0.0.1:${port}/mcp?url=${encodeURIComponent(site1.url)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'create_item', arguments: {} }
    })
  }).then((r) => r.json());
  assert.equal(mutateRes.id, 99);
  assert.equal(mutateRes.error.code, -32602);
  assert.ok(mutateRes.error.message.includes('read-only mode'));

  // 4. Toggle back to read/write mode
  const permRes2 = await fetch(`http://127.0.0.1:${port}/admin/v1/sites/permission`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ url: site1.url, write: true })
  }).then((r) => r.json());
  assert.equal(permRes2.ok, true);
  assert.equal(permRes2.site.write, true);
});

test('Relay addSite supports allowOrigin and allowPrefix options', async (t) => {
  const configDir = makeTempConfigDir();
  const store = createStore({ configDir });

  // 1. allowOrigin: false does NOT add the origin to allowedOrigins
  store.addSite({
    url: 'https://untrusted.example.com/project/mcp',
    allowOrigin: false
  });
  assert.ok(!store.getSnapshot().allowedOrigins.includes('https://untrusted.example.com'));
  assert.ok(store.getSnapshot().allowlist.includes('https://untrusted.example.com/project/mcp'));

  // 2. allowOrigin: true (default) DOES add the origin
  store.addSite({
    url: 'https://trusted.example.com/project/mcp',
    allowOrigin: true
  });
  assert.ok(store.getSnapshot().allowedOrigins.includes('https://trusted.example.com'));

  fs.rmSync(configDir, { recursive: true, force: true });
});


