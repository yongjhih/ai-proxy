import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelContext } from '../web/model-context.mjs';
import { createTabClient, probeRelay } from '../web/client.mjs';
import { executeDirectToolQuery } from '../web/ui.mjs';

test('probeRelay sends no-cors GET request to /healthz', async () => {
  let capturedInit = null;
  let capturedUrl = null;
  const ok = await probeRelay({
    mcpPort: 9876,
    async fetchImpl(url, init) {
      capturedUrl = url;
      capturedInit = init;
      return { type: 'opaque', status: 0, ok: false };
    }
  });

  assert.equal(ok, true);
  assert.equal(capturedUrl, 'http://127.0.0.1:9876/healthz');
  assert.equal(capturedInit.mode, 'no-cors');
});

test('TabClient performs hello -> poll -> ack -> reply and re-hellos on 409 Conflict', async () => {
  const mc = createModelContext();
  mc.registerTool({
    name: 'sum',
    description: 'Add two numbers',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' }
      },
      required: ['a', 'b']
    },
    annotations: { readOnlyHint: true },
    async execute({ a, b }) {
      return { total: a + b };
    }
  });

  const events = [];
  let helloCount = 0;
  let pollStep = 0;
  let client;

  const mockFetch = async (url, init = {}) => {
    const parsed = new URL(url);
    events.push({ method: init.method || 'GET', path: parsed.pathname + parsed.search });

    if (parsed.pathname === '/tab/v1/hello') {
      helloCount += 1;
      return {
        status: 200,
        ok: true,
        async json() {
          return {
            ok: true,
            sessionId: `ses_${helloCount}`,
            pollTimeoutMs: 100
          };
        }
      };
    }

    if (parsed.pathname === '/tab/v1/poll') {
      pollStep += 1;
      if (pollStep === 1) {
        return {
          status: 200,
          ok: true,
          async json() {
            return {
              callId: 'call_1',
              rpc: {
                jsonrpc: '2.0',
                id: 'call_1',
                method: 'tools/call',
                params: { name: 'sum', arguments: { a: 7, b: 8 } }
              }
            };
          }
        };
      }
      if (pollStep === 2) {
        // Simulate relay restart -> 409 Conflict
        return {
          status: 409,
          ok: false,
          async json() {
            return { error: 'Unknown session' };
          }
        };
      }
      // After re-hello (ses_2), stop the client and return 204
      client.stop();
      return {
        status: 204,
        ok: true,
        async json() {
          return {};
        }
      };
    }

    if (parsed.pathname === '/tab/v1/ack') {
      return {
        status: 200,
        ok: true,
        async json() {
          return { ok: true };
        }
      };
    }

    if (parsed.pathname === '/tab/v1/reply') {
      const body = JSON.parse(init.body);
      events.push({ replyBody: body });
      return {
        status: 200,
        ok: true,
        async json() {
          return { ok: true };
        }
      };
    }

    if (parsed.pathname === '/tab/v1/tools') {
      return {
        status: 200,
        ok: true,
        async json() {
          return { ok: true };
        }
      };
    }

    throw new Error(`Unexpected fetch to ${url}`);
  };

  client = createTabClient({
    url: 'https://example.github.io/docs/mcp.html',
    title: 'Docs MCP',
    mcpKey: 'key_abc',
    mcpPort: 9999,
    modelContext: mc,
    fetchImpl: mockFetch
  });

  await client.start();

  // Wait for loop to complete
  await new Promise((r) => setTimeout(r, 60));
  client.stop();

  assert.equal(helloCount, 2, 'Should have re-helloed after 409 Conflict');
  const replyEvent = events.find((e) => e.replyBody);
  assert.ok(replyEvent, 'Should have sent a reply');
  assert.equal(replyEvent.replyBody.callId, 'call_1');
  assert.deepEqual(JSON.parse(replyEvent.replyBody.response.result.content[0].text), { total: 15 });
});

test('executeDirectToolQuery runs read-only tools from ?tool= and refuses non-read-only tools', async () => {
  const mc = createModelContext();
  mc.registerTool({
    name: 'about',
    description: 'Read-only info',
    inputSchema: {
      type: 'object',
      properties: { section: { type: 'string' } }
    },
    annotations: { readOnlyHint: true },
    async execute({ section }) {
      return { service: 'demo', section: section || 'all' };
    }
  });

  mc.registerTool({
    name: 'delete_all',
    description: 'Destructive action',
    annotations: { readOnlyHint: false },
    async execute() {
      return { deleted: true };
    }
  });

  const roRes = await executeDirectToolQuery(mc, '?tool=about&section=security');
  assert.equal(roRes.executed, true);
  assert.deepEqual(roRes.output, { service: 'demo', section: 'security' });

  const mutRes = await executeDirectToolQuery(mc, '?tool=delete_all');
  assert.equal(mutRes.executed, false);
  assert.match(mutRes.error, /read-only/i);
});
