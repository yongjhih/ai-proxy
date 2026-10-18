/**
 * Upstream LLM integration for ai-proxy.
 * Supports OpenAI-compatible endpoints (Ollama, LM Studio, OpenAI, vLLM),
 * Google Gemini (GEMINI_API_KEY), and Anthropic Claude (ANTHROPIC_API_KEY).
 * Zero external runtime dependencies: uses native globalThis.fetch.
 */

export function buildSystemContext({ permittedTools = [], baseContext = '' } = {}) {
  const toolList = (permittedTools || [])
    .map((t) => `- \`${t.fullSpec}\`: ${t.definition?.annotations?.title || t.tool}`)
    .join('\n');

  return [
    'You are the intelligent assistant for MCP Pages & ai-proxy.',
    'MCP Pages turns static websites (such as GitHub Pages) into standard Model Context Protocol (MCP) servers with zero backend.',
    'ai-proxy is a lightweight, zero-dependency local relay (default port 8788) bridging local AI with static WebMCP endpoints.',
    'It strictly enforces 7 security baselines (URL fragment key isolation, path prefix allowlists, origin checking, named read-only tools).',
    '',
    'Available permitted read-only tools on this instance:',
    toolList || '- None currently enabled',
    '',
    'Answer user queries concisely, accurately, and naturally. When referencing pages or dashboard sections, use Markdown links such as [Quickstart](#quickstart), [Spec](doc.html?d=spec), [Security](doc.html?d=security), [Dashboard](dashboard.html), or [WebMCP Tools](mcp.html).',
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
  env = process.env
} = {}) {
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

  const effectiveGeminiKey = geminiKey || env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (effectiveGeminiKey) {
    return {
      type: 'gemini',
      key: effectiveGeminiKey
    };
  }

  const effectiveAnthropicKey = anthropicKey || env.ANTHROPIC_API_KEY;
  if (effectiveAnthropicKey) {
    return {
      type: 'anthropic',
      key: effectiveAnthropicKey
    };
  }

  const effectiveOpenaiKey = openaiKey || env.OPENAI_API_KEY;
  if (effectiveOpenaiKey) {
    return {
      type: 'openai',
      upstreamUrl: 'https://api.openai.com/v1',
      key: effectiveOpenaiKey
    };
  }

  return null;
}

export function createLlmBackend({
  upstreamUrl = undefined,
  upstreamKey = undefined,
  geminiKey = undefined,
  anthropicKey = undefined,
  openaiKey = undefined,
  defaultModel = undefined,
  env = process.env,
  fetchFn = globalThis.fetch
} = {}) {
  const provider = detectLlmProvider({
    upstreamUrl,
    upstreamKey,
    geminiKey,
    anthropicKey,
    openaiKey,
    env
  });

  if (!provider) return null;

  async function chatBackend({ messages = [], model = undefined, permittedTools = [], signal = undefined }) {
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
                : 'default');

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

    // OpenAI or OpenAI-compatible (Ollama, LM Studio, vLLM, etc.)
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
          : 'default');
  chatBackend.upstreamUrl = provider.upstreamUrl || null;

  return chatBackend;
}
