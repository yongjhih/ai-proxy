import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLlmProvider, createLlmBackend, buildSystemContext } from '../src/llm.mjs';
import { createRelayServer } from '../src/relay.mjs';
import { createStore } from '../src/store.mjs';

test('detectLlmProvider detects providers correctly based on flags or env', () => {
  // 1. None
  assert.equal(detectLlmProvider({ env: {} }), null);

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
