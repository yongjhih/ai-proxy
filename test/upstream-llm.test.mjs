import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLlmProvider, createLlmBackend, buildSystemContext, findExecutable } from '../src/llm.mjs';
import { createRelayServer } from '../src/relay.mjs';
import { createStore } from '../src/store.mjs';

test('detectLlmProvider detects providers correctly based on flags or env', () => {
  // 1. None (when no executable found)
  assert.equal(detectLlmProvider({ env: {}, findExecutableFn: () => null }), null);

  // 2. OpenAI-compatible upstream URL
  const p1 = detectLlmProvider({ upstreamUrl: 'http://127.0.0.1:11434/v1', env: {} });
  assert.equal(p1.type, 'openai-compatible');
  assert.equal(p1.upstreamUrl, 'http://127.0.0.1:11434/v1');

  // 3. OPENAI_BASE_URL env
  const p2 = detectLlmProvider({ env: { OPENAI_BASE_URL: 'http://localhost:8000/v1' } });
  assert.equal(p2.type, 'openai-compatible');
  assert.equal(p2.upstreamUrl, 'http://localhost:8000/v1');

  // 4. Gemini key
  const p3 = detectLlmProvider({ geminiKey: 'gemini-secret-123', env: {} });
  assert.equal(p3.type, 'gemini');
  assert.equal(p3.key, 'gemini-secret-123');

  const p4 = detectLlmProvider({ env: { GEMINI_API_KEY: 'env-gemini-key' } });
  assert.equal(p4.type, 'gemini');
  assert.equal(p4.key, 'env-gemini-key');

  // 5. Anthropic key
  const p5 = detectLlmProvider({ anthropicKey: 'claude-key-abc', env: {} });
  assert.equal(p5.type, 'anthropic');
  assert.equal(p5.key, 'claude-key-abc');

  const p6 = detectLlmProvider({ env: { ANTHROPIC_API_KEY: 'env-claude-key' } });
  assert.equal(p6.type, 'anthropic');
  assert.equal(p6.key, 'env-claude-key');

  // 6. OpenAI key
  const p7 = detectLlmProvider({ openaiKey: 'sk-proj-123', env: {} });
  assert.equal(p7.type, 'openai');
  assert.equal(p7.key, 'sk-proj-123');
});

test('buildSystemContext formats knowledge and permitted tools into system prompt', () => {
  const ctx = buildSystemContext({
    permittedTools: [
      { fullSpec: 'mcp__ai-proxy__about', definition: { annotations: { title: 'About MCP' } } },
      { fullSpec: 'mcp__ai-proxy__spec', definition: { annotations: { title: 'Spec doc' } } }
    ]
  });

  assert.ok(ctx.includes('MCP Pages'));
  assert.ok(ctx.includes('mcp__ai-proxy__about'));
  assert.ok(ctx.includes('mcp__ai-proxy__spec'));
});

test('createLlmBackend forwards chat to Google Gemini API', async () => {
  let calledUrl = '';
  let calledBody = null;

  const fakeFetch = async (url, opts) => {
    calledUrl = url;
    calledBody = JSON.parse(opts.body);
    return {
      ok: true,
      async json() {
        return {
          candidates: [
            {
              content: {
                parts: [{ text: 'Gemini says: MCP is Model Context Protocol.' }]
              }
            }
          ]
        };
      }
    };
  };

  const backend = createLlmBackend({
    geminiKey: 'test-gemini-key',
    fetchFn: fakeFetch
  });

  assert.ok(backend);
  assert.equal(backend.provider, 'gemini');

  const reply = await backend({
    messages: [{ role: 'user', content: 'mcp 是什麼？' }],
    permittedTools: [{ fullSpec: 'mcp__ai-proxy__about' }]
  });

  assert.equal(reply, 'Gemini says: MCP is Model Context Protocol.');
  assert.ok(calledUrl.includes('generativelanguage.googleapis.com'));
  assert.ok(calledUrl.includes('test-gemini-key'));
  assert.ok(calledBody.systemInstruction.parts[0].text.includes('mcp__ai-proxy__about'));
  assert.equal(calledBody.contents[0].parts[0].text, 'mcp 是什麼？');
});

test('createLlmBackend forwards chat to Anthropic Claude API', async () => {
  let calledUrl = '';
  let calledHeaders = {};
  let calledBody = null;

  const fakeFetch = async (url, opts) => {
    calledUrl = url;
    calledHeaders = opts.headers;
    calledBody = JSON.parse(opts.body);
    return {
      ok: true,
      async json() {
        return {
          content: [{ type: 'text', text: 'Claude says: MCP Pages turns static sites into tools.' }]
        };
      }
    };
  };

  const backend = createLlmBackend({
    anthropicKey: 'test-anthropic-key',
    fetchFn: fakeFetch
  });

  assert.ok(backend);
  assert.equal(backend.provider, 'anthropic');

  const reply = await backend({
    messages: [{ role: 'user', content: 'mcp 是什麼？' }],
    permittedTools: [{ fullSpec: 'mcp__ai-proxy__about' }]
  });

  assert.equal(reply, 'Claude says: MCP Pages turns static sites into tools.');
  assert.equal(calledUrl, 'https://api.anthropic.com/v1/messages');
  assert.equal(calledHeaders['x-api-key'], 'test-anthropic-key');
  assert.ok(calledBody.system.includes('mcp__ai-proxy__about'));
  assert.equal(calledBody.messages[0].content, 'mcp 是什麼？');
});

test('createLlmBackend forwards chat to OpenAI-compatible endpoint (Ollama / LM Studio)', async () => {
  let calledUrl = '';
  let calledBody = null;

  const fakeFetch = async (url, opts) => {
    calledUrl = url;
    calledBody = JSON.parse(opts.body);
    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Ollama says: MCP connects web pages directly to agents.'
              }
            }
          ]
        };
      }
    };
  };

  const backend = createLlmBackend({
    upstreamUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'llama3',
    fetchFn: fakeFetch
  });

  assert.ok(backend);
  assert.equal(backend.provider, 'openai-compatible');

  const reply = await backend({
    messages: [{ role: 'user', content: 'mcp 是什麼？' }],
    permittedTools: [{ fullSpec: 'mcp__ai-proxy__knowledge' }]
  });

  assert.equal(reply, 'Ollama says: MCP connects web pages directly to agents.');
  assert.equal(calledUrl, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(calledBody.model, 'llama3');
  assert.ok(calledBody.messages[0].content.includes('mcp__ai-proxy__knowledge'));
  assert.equal(calledBody.messages[1].content, 'mcp 是什麼？');
});

test('createRelayServer with real upstream chatBackend uses LLM output for /v1/chat/completions', async (t) => {
  const store = createStore();
  const fakeChatBackend = async ({ messages, model, permittedTools }) => {
    const userPrompt = messages.find((m) => m.role === 'user')?.content || '';
    return `[LLM Response via ${model}]: Natural answer for "${userPrompt}". Permitted tools count: ${permittedTools.length}.`;
  };

  const relay = createRelayServer({
    store,
    port: 0,
    chatBackend: fakeChatBackend,
    openBrowser: async () => {}
  });

  const { port } = await relay.start();
  t.after(async () => {
    await relay.stop();
  });

  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Origin: 'http://127.0.0.1',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'my-custom-llm',
      messages: [{ role: 'user', content: 'mcp 是什麼？請隨意分析' }]
    })
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  const reply = data.choices[0].message.content;

  // Verify that the reply came from the real LLM without any regex intervention!
  assert.ok(reply.includes('[LLM Response via my-custom-llm]'));
  assert.ok(reply.includes('Natural answer for "mcp 是什麼？請隨意分析"'));
  assert.ok(reply.includes('Permitted tools count: 7'));
});

test('findExecutable locates system binaries and returns null for non-existent ones', () => {
  const nodeBin = findExecutable('node');
  assert.ok(typeof nodeBin === 'string');
  assert.ok(nodeBin.includes('node'));

  const missing = findExecutable('non_existent_binary_xyza_98765');
  assert.equal(missing, null);
});

test('detectLlmProvider auto-detects agy or claude CLI and respects cliName override', () => {
  const fakeFind = (name) => {
    if (name === 'agy') return '/fake/bin/agy';
    if (name === 'claude') return '/fake/bin/claude';
    return null;
  };

  // 1. Auto-detect picks agy first
  const p1 = detectLlmProvider({ env: {}, findExecutableFn: fakeFind });
  assert.equal(p1.type, 'agy-cli');
  assert.equal(p1.binPath, '/fake/bin/agy');
  assert.equal(p1.cliName, 'agy');

  // 2. When agy is not found, picks claude
  const fakeFindClaudeOnly = (name) => (name === 'claude' ? '/fake/bin/claude' : null);
  const p2 = detectLlmProvider({ env: {}, findExecutableFn: fakeFindClaudeOnly });
  assert.equal(p2.type, 'claude-cli');
  assert.equal(p2.binPath, '/fake/bin/claude');
  assert.equal(p2.cliName, 'claude');

  // 3. Explicit cliName override selects claude even if agy exists
  const p3 = detectLlmProvider({ cliName: 'claude', env: {}, findExecutableFn: fakeFind });
  assert.equal(p3.type, 'claude-cli');
  assert.equal(p3.binPath, '/fake/bin/claude');

  // 4. Upstream URL takes precedence over local CLIs
  const p4 = detectLlmProvider({ upstreamUrl: 'http://127.0.0.1:8000/v1', env: {}, findExecutableFn: fakeFind });
  assert.equal(p4.type, 'openai-compatible');
});

test('createLlmBackend with agy-cli maintains multi-turn session with --conversation', async () => {
  const executionCalls = [];

  const fakeExecFile = (bin, args, opts, cb) => {
    executionCalls.push({ bin, args });
    const isFirstTurn = !args.includes('--conversation');
    if (isFirstTurn) {
      const resp = {
        conversation_id: 'agy-conv-uuid-42',
        status: 'SUCCESS',
        response: 'AGY turn 1 answer: MCP is Model Context Protocol.'
      };
      cb(null, JSON.stringify(resp), '');
    } else {
      const resp = {
        conversation_id: 'agy-conv-uuid-42',
        status: 'SUCCESS',
        response: 'AGY turn 2 answer: Following up with session context.'
      };
      cb(null, JSON.stringify(resp), '');
    }
  };

  const backend = createLlmBackend({
    cliName: 'agy',
    findExecutableFn: () => '/mock/agy',
    execFileFn: fakeExecFile
  });

  assert.ok(backend);
  assert.equal(backend.provider, 'agy-cli');
  assert.equal(backend.model, 'agy');

  // Turn 1
  const reply1 = await backend({
    messages: [{ role: 'user', content: 'mcp 是什麼？' }],
    permittedTools: [{ fullSpec: 'mcp__ai-proxy__about' }],
    sessionId: 'browser-tab-session-1'
  });

  assert.equal(reply1, 'AGY turn 1 answer: MCP is Model Context Protocol.');
  assert.equal(executionCalls.length, 1);
  assert.equal(executionCalls[0].bin, '/mock/agy');
  assert.ok(executionCalls[0].args.includes('-p'));
  assert.ok(executionCalls[0].args[1].includes('mcp__ai-proxy__about'));
  assert.ok(executionCalls[0].args[1].includes('mcp 是什麼？'));
  assert.equal(backend.sessionMap.get('browser-tab-session-1'), 'agy-conv-uuid-42');

  // Turn 2 for same session
  const reply2 = await backend({
    messages: [{ role: 'user', content: '如何開始使用？' }],
    permittedTools: [{ fullSpec: 'mcp__ai-proxy__about' }],
    sessionId: 'browser-tab-session-1'
  });

  assert.equal(reply2, 'AGY turn 2 answer: Following up with session context.');
  assert.equal(executionCalls.length, 2);
  assert.ok(executionCalls[1].args.includes('--conversation'));
  assert.equal(executionCalls[1].args[1], 'agy-conv-uuid-42');
  assert.ok(executionCalls[1].args.includes('-p'));
  assert.equal(executionCalls[1].args[3], '如何開始使用？');
});

test('createLlmBackend with claude-cli persists UUID session-id across turns', async () => {
  const executionCalls = [];

  const fakeExecFile = (bin, args, opts, cb) => {
    executionCalls.push({ bin, args });
    cb(null, 'Claude Code: Analysis response for user prompt.\n', '');
  };

  const backend = createLlmBackend({
    cliName: 'claude',
    findExecutableFn: () => '/mock/claude',
    execFileFn: fakeExecFile
  });

  assert.ok(backend);
  assert.equal(backend.provider, 'claude-cli');
  assert.equal(backend.model, 'claude');

  // Turn 1
  const reply1 = await backend({
    messages: [{ role: 'user', content: '什麼是 ai-proxy？' }],
    permittedTools: [{ fullSpec: 'mcp__ai-proxy__spec' }],
    sessionId: 'drawer-session-alpha'
  });

  assert.equal(reply1, 'Claude Code: Analysis response for user prompt.');
  assert.equal(executionCalls.length, 1);
  const sessionIdx = executionCalls[0].args.indexOf('--session-id');
  assert.ok(sessionIdx !== -1);
  const assignedUuid = executionCalls[0].args[sessionIdx + 1];
  assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assignedUuid));

  // Turn 2
  await backend({
    messages: [{ role: 'user', content: '第二個問題' }],
    sessionId: 'drawer-session-alpha'
  });

  assert.equal(executionCalls.length, 2);
  const sessionIdx2 = executionCalls[1].args.indexOf('--session-id');
  assert.equal(executionCalls[1].args[sessionIdx2 + 1], assignedUuid);
});

test('createRelayServer passes sessionId and provider to /v1/chat/completions', async (t) => {
  const store = createStore();
  let receivedSessionId = null;

  const fakeChatBackend = async ({ messages, sessionId }) => {
    receivedSessionId = sessionId;
    return `Session confirmed: ${sessionId}`;
  };
  fakeChatBackend.provider = 'agy-cli';

  const relay = createRelayServer({
    store,
    port: 0,
    chatBackend: fakeChatBackend,
    openBrowser: async () => {}
  });

  const { port } = await relay.start();
  t.after(async () => {
    await relay.stop();
  });

  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Origin: 'http://127.0.0.1',
      'Content-Type': 'application/json',
      'X-Session-ID': 'test-session-999'
    },
    body: JSON.stringify({
      user: 'test-session-999',
      messages: [{ role: 'user', content: 'mcp 是什麼？' }]
    })
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(receivedSessionId, 'test-session-999');
  assert.equal(data.choices[0].message.content, 'Session confirmed: test-session-999');
  assert.equal(data.ai_proxy.provider, 'agy-cli');
});

