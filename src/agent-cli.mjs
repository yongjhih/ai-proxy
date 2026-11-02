import readline from 'node:readline';
import crypto from 'node:crypto';

/**
 * Lightweight AI Agent Client CLI for ai-proxy.
 * Connects directly to ai-proxy's OpenAI-compatible /v1/chat/completions endpoint.
 * Supports:
 *   - Single-shot prompt: npx ai-proxy agent "your question" (or piped stdin)
 *   - Interactive multi-turn REPL: npx ai-proxy agent (or npx ai-proxy chat)
 *   - Session persistence and slash commands (/help, /clear, /session, /tools, /exit)
 * Zero external dependencies: native Node.js readline, crypto, fetch.
 */

export async function runAgentCli({
  host = '127.0.0.1',
  port = 8788,
  prompt = '',
  session = '',
  model = 'local-default',
  json = false,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env
} = {}) {
  const effectiveHost = host || env.AI_PROXY_HOST || '127.0.0.1';
  const effectivePort = port || Number.parseInt(env.AI_PROXY_PORT || '8788', 10);
  const baseUrl = `http://${effectiveHost}:${effectivePort}`;
  const v1Endpoint = `${baseUrl}/v1/chat/completions`;
  const healthEndpoint = `${baseUrl}/healthz`;

  let currentSession =
    session ||
    env.AI_PROXY_SESSION_ID ||
    `agent_${crypto.randomBytes(4).toString('hex')}`;

  async function checkHealth() {
    try {
      const res = await fetch(healthEndpoint, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        return await res.json();
      }
    } catch {
      // unreachable
    }
    return null;
  }

  async function callChat(messages, opts = {}) {
    const payload = {
      model: opts.model || model,
      messages,
      user: currentSession
    };
    const res = await fetch(v1Endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': currentSession
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const errJson = await res.json();
        if (errJson && errJson.error && errJson.error.message) {
          errMsg = errJson.error.message;
        } else if (errJson && errJson.error) {
          errMsg = typeof errJson.error === 'string' ? errJson.error : JSON.stringify(errJson.error);
        }
      } catch {}
      throw new Error(errMsg);
    }

    return await res.json();
  }

  // 1. Single-shot prompt mode (if prompt argument is provided)
  if (prompt && prompt.trim()) {
    const userPrompt = prompt.trim();
    try {
      const resp = await callChat([{ role: 'user', content: userPrompt }]);
      if (json) {
        stdout.write(`${JSON.stringify(resp, null, 2)}\n`);
      } else {
        const choice = resp.choices && resp.choices[0];
        const content = choice && choice.message ? choice.message.content : '';
        stdout.write(`${content}\n`);
      }
      return 0;
    } catch (err) {
      stderr.write(`Error connecting to ai-proxy at ${baseUrl}: ${err.message}\n`);
      stderr.write(`Make sure ai-proxy is running: npx ai-proxy serve --port ${effectivePort}\n`);
      return 1;
    }
  }

  // 2. Check if stdin is piped (non-TTY and no prompt argument was supplied)
  // Only check if stdin is a real TTY object (has isTTY property defined as false)
  if (stdin && stdin.isTTY === false && typeof stdin[Symbol.asyncIterator] === 'function') {
    // If stdin is an empty stream or contains text
    let pipedInput = '';
    const rlPiped = readline.createInterface({ input: stdin, crlfDelay: Infinity });
    for await (const line of rlPiped) {
      pipedInput += (pipedInput ? '\n' : '') + line;
    }
    if (pipedInput.trim()) {
      return runAgentCli({
        host: effectiveHost,
        port: effectivePort,
        prompt: pipedInput.trim(),
        session: currentSession,
        model,
        json,
        stdin: null,
        stdout,
        stderr,
        env
      });
    }
  }

  // 3. Interactive REPL Mode
  const health = await checkHealth();
  if (!health) {
    stderr.write(`Error: cannot connect to ai-proxy relay at ${baseUrl}\n`);
    stderr.write(`Please start ai-proxy first:\n  npx ai-proxy serve --port ${effectivePort}\n`);
    stderr.write(`Or install background service with:\n  npx ai-proxy install --login\n`);
    return 1;
  }

  stderr.write(`\n=== ai-proxy Agent Client CLI ===\n`);
  stderr.write(`Connected: ${baseUrl} (ai-proxy v${health.version || '1.0.0'})\n`);
  stderr.write(`Session:   ${currentSession}\n`);
  stderr.write(`Type /help for slash commands, /exit or Ctrl+C to quit.\n\n`);

  const messages = [];

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    prompt: 'ai-proxy> '
  });

  rl.prompt();

  for await (const rawLine of rl) {
    const line = rawLine.trim();

    if (!line) {
      rl.prompt();
      continue;
    }

    if (line.startsWith('/')) {
      const [cmd, ...args] = line.slice(1).split(/\s+/);
      const subCmd = cmd.toLowerCase();

      if (subCmd === 'exit' || subCmd === 'quit' || subCmd === 'q') {
        stderr.write('Bye!\n');
        break;
      }

      if (subCmd === 'clear' || subCmd === 'reset') {
        messages.length = 0;
        stderr.write(`Conversation history cleared.\n`);
        rl.prompt();
        continue;
      }

      if (subCmd === 'session') {
        const newSession = args[0];
        if (newSession) {
          currentSession = newSession;
          messages.length = 0;
          stderr.write(`Session switched to "${currentSession}". History reset.\n`);
        } else {
          stderr.write(`Current session ID: ${currentSession} (${messages.length} messages in memory)\n`);
        }
        rl.prompt();
        continue;
      }

      if (subCmd === 'tools') {
        try {
          const testResp = await callChat([
            { role: 'user', content: 'What tools are available?' }
          ]);
          const permitted = testResp.ai_proxy?.permittedReadOnlyTools || [];
          if (permitted.length > 0) {
            stderr.write(`Permitted read-only tools on /v1 (${permitted.length}):\n`);
            for (const t of permitted) {
              stderr.write(`  - ${t}\n`);
            }
          } else {
            stderr.write(`No specific tools permitted on /v1 (pure-chat mode or no --allow-tool flags set).\n`);
          }
        } catch (err) {
          stderr.write(`Could not fetch tools: ${err.message}\n`);
        }
        rl.prompt();
        continue;
      }

      if (subCmd === 'help') {
        stderr.write(`Available commands:\n`);
        stderr.write(`  /help          Show this help message\n`);
        stderr.write(`  /clear         Clear conversation history\n`);
        stderr.write(`  /session [id]  Show or change current session ID\n`);
        stderr.write(`  /tools         List permitted read-only tools on /v1\n`);
        stderr.write(`  /exit, /quit   Exit the agent CLI\n`);
        rl.prompt();
        continue;
      }

      stderr.write(`Unknown command: /${cmd}. Type /help for available commands.\n`);
      rl.prompt();
      continue;
    }

    // Normal multi-turn chat turn
    messages.push({ role: 'user', content: line });
    try {
      stderr.write('Thinking...\r');
      const resp = await callChat(messages);
      stderr.write('           \r');

      const choice = resp.choices && resp.choices[0];
      const reply = choice && choice.message ? choice.message.content : '';
      messages.push({ role: 'assistant', content: reply });

      stdout.write(`${reply}\n\n`);
    } catch (err) {
      stderr.write(`Error: ${err.message}\n\n`);
      messages.pop();
    }

    rl.prompt();
  }

  return 0;
}
