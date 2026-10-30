import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';

/**
 * Upstream LLM integration for ai-proxy.
 * Supports:
 *  1. Auto-detected local AI CLIs:
 *     - agy CLI (Gemini-powered AGY agent with multi-turn --conversation session persistence)
 *     - claude CLI (Claude Code CLI with --session-id persistence)
 *  2. Cloud / Upstream HTTP endpoints:
 *     - OpenAI-compatible endpoints (Ollama, LM Studio, OpenAI, vLLM)
 *     - Google Gemini API (GEMINI_API_KEY)
 *     - Anthropic Claude API (ANTHROPIC_API_KEY)
 * Zero external runtime dependencies: uses native Node.js child_process, crypto, and globalThis.fetch.
 */

export function findExecutable(name, env = process.env) {
  if (!name || typeof name !== 'string') return null;

  // If already an absolute or relative path containing path separator
  if (name.includes('/') || (process.platform === 'win32' && name.includes('\\'))) {
    try {
      if (fs.existsSync(name) && fs.statSync(name).isFile()) {
        return path.resolve(name);
      }
    } catch {
      return null;
    }
  }

  const pathEnv = env.PATH || '';
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];

  const homeDir = env.HOME || (typeof os.homedir === 'function' ? os.homedir() : '');
  const searchDirs = [
    ...dirs,
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(homeDir, '.local', 'bin'),
    path.join(homeDir, '.cargo', 'bin'),
    path.join(homeDir, '.npm-global', 'bin')
  ];

  const seen = new Set();
  for (const dir of searchDirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try {
        if (fs.existsSync(full)) {
          const stat = fs.statSync(full);
          if (stat.isFile()) {
            return full;
          }
        }
      } catch {
        // continue
      }
    }
  }
  return null;
}

export function buildSystemContext({ permittedTools = [], baseContext = '' } = {}) {
  const toolList = (permittedTools || [])
    .map((t) => `- \`${t.fullSpec}\`: ${t.definition?.annotations?.title || t.tool}`)
    .join('\n');

  const linksInstruction = baseContext
    ? 'When providing links or referencing files, strictly follow the linking instructions and URL formats specified in the caller context. Never output local file:// URLs, localhost filesystem paths, or references to ai-proxy internal files unless explicitly asked about ai-proxy itself.'
    : 'Answer user queries concisely, accurately, and naturally. When referencing pages or dashboard sections, use Markdown links such as [Quickstart](#quickstart), [Spec](doc.html?d=spec), [Security](doc.html?d=security), [Dashboard](dashboard.html), or [WebMCP Tools](mcp.html). Never output local file:// URLs.';

  return [
    'You are the intelligent assistant for MCP Pages & ai-proxy.',
    'MCP Pages turns static websites (such as GitHub Pages) into standard Model Context Protocol (MCP) servers with zero backend.',
    'ai-proxy is a lightweight, zero-dependency local relay (default port 8788) bridging local AI with static WebMCP endpoints.',
    'It strictly enforces 7 security baselines (URL fragment key isolation, path prefix allowlists, origin checking, named read-only tools).',
    '',
    'Available permitted read-only tools on this instance:',
    toolList || '- None currently enabled',
    '',
    linksInstruction,
    baseContext
  ]
    .filter(Boolean)
    .join('\n');
}

export function detectLlmProvider({
  upstreamUrl = undefined,
  upstreamKey = undefined,
  geminiKey = undefined,
  anthropicKey = undefined,
  openaiKey = undefined,
  cliName = undefined,
  env = process.env,
  findExecutableFn = findExecutable
} = {}) {
  // 1. Explicit upstream URL / base URL
  const effectiveUpstream =
    upstreamUrl ||
    env.AI_PROXY_UPSTREAM_URL ||
    env.OPENAI_BASE_URL ||
    env.OPENAI_API_BASE;

  if (effectiveUpstream) {
    return {
      type: 'openai-compatible',
      upstreamUrl: effectiveUpstream,
      key: upstreamKey || openaiKey || env.AI_PROXY_UPSTREAM_KEY || env.OPENAI_API_KEY || ''
    };
  }

  // 2. Explicit Google Gemini API Key
  const effectiveGeminiKey = geminiKey || env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (effectiveGeminiKey) {
    return {
      type: 'gemini',
      key: effectiveGeminiKey
    };
  }

  // 3. Explicit Anthropic Claude API Key
  const effectiveAnthropicKey = anthropicKey || env.ANTHROPIC_API_KEY;
  if (effectiveAnthropicKey) {
    return {
      type: 'anthropic',
      key: effectiveAnthropicKey
    };
  }

  // 4. Explicit OpenAI API Key
  const effectiveOpenaiKey = openaiKey || env.OPENAI_API_KEY;
  if (effectiveOpenaiKey) {
    return {
      type: 'openai',
      upstreamUrl: 'https://api.openai.com/v1',
      key: effectiveOpenaiKey
    };
  }

  // 5. Explicit CLI option or auto-detect local CLI (agy or claude)
  const targetCli = cliName || env.AI_PROXY_CLI;
  if (targetCli) {
    const bin = findExecutableFn(targetCli, env);
    if (bin) {
      return {
        type: `${targetCli}-cli`,
        binPath: bin,
        cliName: targetCli
      };
    }
  } else {
    // Check agy first (fast, Gemini-powered, supports multi-turn JSON output)
    const agyBin = findExecutableFn('agy', env);
    if (agyBin) {
      return {
        type: 'agy-cli',
        binPath: agyBin,
        cliName: 'agy'
      };
    }
    // Check claude CLI (Claude Code)
    const claudeBin = findExecutableFn('claude', env);
    if (claudeBin) {
      return {
        type: 'claude-cli',
        binPath: claudeBin,
        cliName: 'claude'
      };
    }
  }

  return null;
}

export function createLlmBackend({
  upstreamUrl = undefined,
  upstreamKey = undefined,
  geminiKey = undefined,
  anthropicKey = undefined,
  openaiKey = undefined,
  cliName = undefined,
  defaultModel = undefined,
  env = process.env,
  fetchFn = globalThis.fetch,
  findExecutableFn = findExecutable,
  execFileFn = childProcess.execFile
} = {}) {
  const provider = detectLlmProvider({
    upstreamUrl,
    upstreamKey,
    geminiKey,
    anthropicKey,
    openaiKey,
    cliName,
    env,
    findExecutableFn
  });

  if (!provider) return null;

  // Persistent session mapping for CLI callers
  // For agy: sessionId -> conversationId
  // For claude: sessionId -> uuid
  const sessionMap = new Map();

  async function chatBackend({
    messages = [],
    model = undefined,
    permittedTools = [],
    sessionId = 'default',
    signal = undefined
  }) {
    const effectiveModel =
      model && model !== 'local-default' && model !== 'local'
        ? model
        : defaultModel ||
          (provider.type === 'gemini'
            ? 'gemini-1.5-flash'
            : provider.type === 'anthropic'
              ? 'claude-3-5-sonnet-20241022'
              : provider.type === 'openai'
                ? 'gpt-4o-mini'
                : provider.type === 'agy-cli'
                  ? 'agy'
                  : provider.type === 'claude-cli'
                    ? 'claude'
                    : 'default');

    // 1. agy CLI
    if (provider.type === 'agy-cli') {
      const activeSessionId = String(sessionId || 'default');
      const savedConversationId = sessionMap.get(activeSessionId);

      const systemMessages = messages.filter((m) => m && m.role === 'system');
      const baseSysText = systemMessages.map((m) => m.content).join('\n');
      const systemContext = buildSystemContext({ permittedTools, baseContext: baseSysText });

      const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
      const userPrompt = lastUser && typeof lastUser.content === 'string' ? lastUser.content : 'Hello';

      let args = [];
      if (savedConversationId) {
        // Resuming conversation: agy already has context from prior turns
        args = ['--conversation', savedConversationId, '-p', userPrompt, '--output-format', 'json'];
      } else {
        // First turn of this session: inject system prompt instructions
        const initialPrompt = `${systemContext}\n\n---\nUser query: ${userPrompt}`;
        args = ['-p', initialPrompt, '--output-format', 'json'];
      }

      const runAgy = (cliArgs) =>
        new Promise((resolve, reject) => {
          execFileFn(
            provider.binPath,
            cliArgs,
            {
              timeout: 90000,
              maxBuffer: 10 * 1024 * 1024,
              signal
            },
            (err, stdout, stderr) => {
              if (err) {
                const msg = (stderr || stdout || err.message).trim();
                return reject(new Error(`agy CLI execution failed: ${msg}`));
              }
              try {
                const parsed = JSON.parse(stdout);
                if (parsed.status && parsed.status !== 'SUCCESS') {
                  return reject(new Error(`agy CLI error: ${parsed.status}`));
                }
                resolve(parsed);
              } catch {
                resolve({ response: stdout });
              }
            }
          );
        });

      let resData;
      try {
        resData = await runAgy(args);
      } catch (err) {
        // If resuming a conversation failed (e.g. conversation expired or not found),
        // gracefully fall back to starting a fresh conversation
        if (savedConversationId) {
          sessionMap.delete(activeSessionId);
          const initialPrompt = `${systemContext}\n\n---\nUser query: ${userPrompt}`;
          resData = await runAgy(['-p', initialPrompt, '--output-format', 'json']);
        } else {
          throw err;
        }
      }

      if (resData.conversation_id) {
        sessionMap.set(activeSessionId, resData.conversation_id);
      }

      return (resData.response || '').trim();
    }

    // 2. claude CLI
    if (provider.type === 'claude-cli') {
      const activeSessionId = String(sessionId || 'default');
      let claudeUuid = sessionMap.get(activeSessionId);
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!claudeUuid) {
        claudeUuid = uuidRegex.test(activeSessionId)
          ? activeSessionId
          : crypto.randomUUID();
        sessionMap.set(activeSessionId, claudeUuid);
      }

      const systemMessages = messages.filter((m) => m && m.role === 'system');
      const baseSysText = systemMessages.map((m) => m.content).join('\n');
      const systemPrompt = buildSystemContext({ permittedTools, baseContext: baseSysText });

      const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
      const userPrompt = lastUser && typeof lastUser.content === 'string' ? lastUser.content : 'Hello';

      const args = [
        '-p',
        userPrompt,
        '--session-id',
        claudeUuid,
        '--system-prompt',
        systemPrompt,
        '--output-format',
        'text',
        '--tools',
        ''
      ];

      return new Promise((resolve, reject) => {
        execFileFn(
          provider.binPath,
          args,
          {
            timeout: 90000,
            maxBuffer: 10 * 1024 * 1024,
            signal
          },
          (err, stdout, stderr) => {
            if (err) {
              const msg = (stderr || stdout || err.message).trim();
              return reject(new Error(`claude CLI execution failed: ${msg}`));
            }
            resolve(String(stdout || '').trim());
          }
        );
      });
    }

    // 3. Google Gemini API
    if (provider.type === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        effectiveModel
      )}:generateContent?key=${encodeURIComponent(provider.key)}`;

      const systemMessages = messages.filter((m) => m && m.role === 'system');
      const baseSysText = systemMessages.map((m) => m.content).join('\n');
      const systemInstructionText = buildSystemContext({ permittedTools, baseContext: baseSysText });

      const conversationMessages = messages.filter((m) => m && m.role !== 'system');
      const contents = conversationMessages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(m.content || '') }]
      }));

      if (contents.length === 0) {
        contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
      }

      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstructionText }] },
          contents
        }),
        signal
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errMsg = data.error?.message || `Gemini API returned HTTP ${res.status}`;
        throw new Error(errMsg);
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      return typeof text === 'string' ? text : '';
    }

    // 4. Anthropic Claude API
    if (provider.type === 'anthropic') {
      const url = 'https://api.anthropic.com/v1/messages';
      const systemMessages = messages.filter((m) => m && m.role === 'system');
      const baseSysText = systemMessages.map((m) => m.content).join('\n');
      const systemPrompt = buildSystemContext({ permittedTools, baseContext: baseSysText });

      const conversationMessages = messages
        .filter((m) => m && m.role !== 'system')
        .map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: String(m.content || '')
        }));

      if (conversationMessages.length === 0) {
        conversationMessages.push({ role: 'user', content: 'Hello' });
      }

      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': provider.key,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: effectiveModel,
          max_tokens: 2048,
          system: systemPrompt,
          messages: conversationMessages
        }),
        signal
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errMsg = data.error?.message || `Anthropic API returned HTTP ${res.status}`;
        throw new Error(errMsg);
      }

      const text = data.content?.[0]?.text;
      return typeof text === 'string' ? text : '';
    }

    // 5. OpenAI or OpenAI-compatible (Ollama, LM Studio, vLLM, etc.)
    let endpoint = provider.upstreamUrl || 'https://api.openai.com/v1';
    if (!endpoint.endsWith('/chat/completions')) {
      endpoint = endpoint.replace(/\/+$/, '') + '/chat/completions';
    }

    const systemMessages = messages.filter((m) => m && m.role === 'system');
    const baseSysText = systemMessages.map((m) => m.content).join('\n');
    const systemPrompt = buildSystemContext({ permittedTools, baseContext: baseSysText });

    const formattedMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.filter((m) => m && m.role !== 'system').map((m) => ({
        role: m.role,
        content: String(m.content || '')
      }))
    ];

    const headers = { 'Content-Type': 'application/json' };
    if (provider.key) {
      headers['Authorization'] = `Bearer ${provider.key}`;
    }

    const payload = {
      model: effectiveModel,
      messages: formattedMessages
    };

    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = (data && data.error && (data.error.message || data.error)) || `Upstream returned HTTP ${res.status}`;
      throw new Error(errMsg);
    }

    const text = data.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text : '';
  }

  chatBackend.provider = provider.type;
  chatBackend.model =
    defaultModel ||
    (provider.type === 'gemini'
      ? 'gemini-1.5-flash'
      : provider.type === 'anthropic'
        ? 'claude-3-5-sonnet-20241022'
        : provider.type === 'openai'
          ? 'gpt-4o-mini'
          : provider.type === 'agy-cli'
            ? 'agy'
            : provider.type === 'claude-cli'
              ? 'claude'
              : 'default');
  chatBackend.upstreamUrl = provider.upstreamUrl || null;
  chatBackend.binPath = provider.binPath || null;
  chatBackend.sessionMap = sessionMap;

  return chatBackend;
}
