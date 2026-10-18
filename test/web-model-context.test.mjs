import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelContext } from '../web/model-context.mjs';
import { createMcpDispatcher } from '../web/dispatch.mjs';

test('ModelContext validates tool definitions strictly', () => {
  const mc = createModelContext();

  assert.throws(() => mc.registerTool(null), /Tool definition must be an object/i);
  assert.throws(() => mc.registerTool({ name: 'bad name!', description: 'x', execute() {} }), /Invalid tool name/i);
  assert.throws(() => mc.registerTool({ name: 'valid_name', description: '', execute() {} }), /description/i);
  assert.throws(
    () => mc.registerTool({ name: 'valid_name', description: 'ok', inputSchema: { type: 'string' }, execute() {} }),
    /inputSchema\.type must be "object"/i
  );
  assert.throws(
    () => mc.registerTool({ name: 'valid_name', description: 'ok' }),
    /execute must be a function/i
  );
});

test('ModelContext normalizes annotations.readOnlyHint to boolean and validates input parameters', async () => {
  const mc = createModelContext();

  mc.registerTool({
    name: 'search_items',
    description: 'Search items with filter',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer' },
        category: { type: 'string', enum: ['books', 'music'] }
      },
      required: ['query'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true },
    async execute(input) {
      return { found: input.query, limit: input.limit ?? 10 };
    }
  });

  mc.registerTool({
    name: 'mutate_item',
    description: 'Mutates state',
    async execute() {
      return { ok: true };
    }
  });

  const listed = mc.listTools();
  assert.equal(listed.length, 2);
  assert.equal(listed[0].annotations.readOnlyHint, true);
  assert.equal(listed[1].annotations.readOnlyHint, false);

  // Valid call
  const res = await mc.callTool('search_items', { query: 'jazz', limit: 5, category: 'music' });
  assert.deepEqual(res, { found: 'jazz', limit: 5 });

  // Missing required field
  await assert.rejects(
    () => mc.callTool('search_items', {}),
    (err) => err.code === -32602 && /Missing required property "query"/i.test(err.message)
  );

  // Wrong type (float instead of integer)
  await assert.rejects(
    () => mc.callTool('search_items', { query: 'jazz', limit: 3.5 }),
    (err) => err.code === -32602 && /limit/i.test(err.message)
  );

  // Violates enum
  await assert.rejects(
    () => mc.callTool('search_items', { query: 'jazz', category: 'movies' }),
    (err) => err.code === -32602 && /enum/i.test(err.message)
  );

  // Unknown additional property
  await assert.rejects(
    () => mc.callTool('search_items', { query: 'jazz', extra: true }),
    (err) => err.code === -32602 && /Unknown property "extra"/i.test(err.message)
  );
});

test('ModelContext and MCP Dispatcher support AbortSignal cancellation', async () => {
  const mc = createModelContext();
  let signalAbortedInsideTool = false;

  mc.registerTool({
    name: 'slow_task',
    description: 'Wait until aborted',
    annotations: { readOnlyHint: true },
    async execute(_input, { signal }) {
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          signalAbortedInsideTool = true;
          reject(new Error('Aborted by signal'));
        });
      });
    }
  });

  const dispatcher = createMcpDispatcher(mc, { name: 'test-page', version: '1.0.0' });

  // Start slow tool call with id 77
  const callPromise = dispatcher.handle({
    jsonrpc: '2.0',
    id: 77,
    method: 'tools/call',
    params: { name: 'slow_task', arguments: {} }
  });

  // Cancel it via notifications/cancelled
  await new Promise((r) => setTimeout(r, 20));
  const cancelRes = await dispatcher.handle({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 77, reason: 'User pressed Esc' }
  });
  assert.equal(cancelRes, null);

  const reply = await callPromise;
  assert.equal(signalAbortedInsideTool, true);
  assert.equal(reply.id, 77);
  assert.equal(reply.error.code, -32800);
});

test('MCP Dispatcher handles initialize, server/discover (-32601), tools/list, and tools/call', async () => {
  const mc = createModelContext();
  mc.registerTool({
    name: 'echo',
    description: 'Echoes text',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    },
    annotations: { readOnlyHint: true },
    async execute({ text }) {
      return { echoed: text };
    }
  });

  const dispatcher = createMcpDispatcher(mc, { name: 'demo-mcp', version: '1.0.0' });

  const discover = await dispatcher.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'server/discover',
    params: {}
  });
  assert.equal(discover.error.code, -32601);

  const init = await dispatcher.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25' }
  });
  assert.equal(init.result.protocolVersion, '2025-11-25');

  const list = await dispatcher.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/list',
    params: {}
  });
  assert.equal(list.result.tools.length, 1);
  assert.equal(list.result.tools[0].name, 'echo');

  const call = await dispatcher.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'echo', arguments: { text: 'hello' } }
  });
  assert.equal(call.result.isError, false);
  assert.deepEqual(JSON.parse(call.result.content[0].text), { echoed: 'hello' });
});
