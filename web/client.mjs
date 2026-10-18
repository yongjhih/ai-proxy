/**
 * Browser tab connection client to ai-proxy (/tab/v1/hello, /poll, /ack, /reply, /tools).
 * Handles idle long-polling, 409 Conflict automatic re-hello, and no-cors liveness probing.
 */

import { normalizePageUrl } from './url.mjs';
import { createMcpDispatcher } from './dispatch.mjs';

export async function probeRelay({
  mcpPort = 8788,
  host = '127.0.0.1',
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof fetchImpl !== 'function') return false;
  try {
    await fetchImpl(`http://${host}:${mcpPort}/healthz`, {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store'
    });
    return true;
  } catch {
    return false;
  }
}

export function createTabClient({
  url,
  title = '',
  mcpKey,
  mcpPort = 8788,
  host = '127.0.0.1',
  modelContext,
  dispatcher = undefined,
  fetchImpl = globalThis.fetch,
  onStateChange = undefined
}) {
  if (!modelContext) {
    throw new TypeError('createTabClient requires modelContext');
  }

  const normalizedUrl = normalizePageUrl(url);
  const baseUrl = `http://${host}:${mcpPort}`;
  const mcpDispatcher =
    dispatcher ||
    createMcpDispatcher(modelContext, {
      name: title || normalizedUrl,
      version: '1.0.0',
      pageUrl: normalizedUrl
    });

  let running = false;
  let sessionId = null;
  let pollController = null;
  let unsubscribeTools = null;
  let state = {
    status: mcpKey ? 'connecting' : 'standalone',
    sessionId: null,
    error: null,
    normalizedUrl,
    mcpPort
  };

  function updateState(patch) {
    state = { ...state, ...patch };
    if (typeof onStateChange === 'function') {
      try {
        onStateChange(state);
      } catch {
        // Ignore callback errors
      }
    }
  }

  function authHeaders() {
    return {
      'Content-Type': 'application/json',
      ...(mcpKey ? { Authorization: `Bearer ${mcpKey}` } : {})
    };
  }

  async function hello() {
    const res = await fetchImpl(`${baseUrl}/tab/v1/hello`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        url: normalizedUrl,
        title: title || '',
        tools: modelContext.listTools()
      })
    });

    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const errBody = await res.json();
        if (errBody && errBody.error) msg = errBody.error;
      } catch {
        // Ignore JSON parse error
      }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    sessionId = data.sessionId;
    updateState({
      status: 'connected',
      sessionId,
      error: null
    });
    return data;
  }

  async function pushTools(tools) {
    if (!running || !sessionId || !mcpKey) return;
    try {
      const res = await fetchImpl(`${baseUrl}/tab/v1/tools`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          sessionId,
          tools
        })
      });
      if (res.status === 409 && running) {
        sessionId = null;
        await hello();
      }
    } catch {
      // Next poll cycle will recover
    }
  }

  async function handleIncomingCall(callId, rpc) {
    // 1. Acknowledge immediately
    try {
      const ackRes = await fetchImpl(`${baseUrl}/tab/v1/ack`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ sessionId, callId })
      });
      if (ackRes.status === 409) {
        sessionId = null;
        return;
      }
    } catch {
      // Continue to execute and attempt reply
    }

    // 2. Dispatch RPC against ModelContext
    const response = await mcpDispatcher.handle(rpc);
    if (response === null) return;

    // 3. Send reply back to relay
    try {
      const replyRes = await fetchImpl(`${baseUrl}/tab/v1/reply`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          sessionId,
          callId,
          response
        })
      });
      if (replyRes.status === 409) {
        sessionId = null;
      }
    } catch {
      // Relay will handle timeout or reconnect
    }
  }

  async function pollLoop() {
    while (running) {
      try {
        if (!sessionId) {
          await hello();
        }
        if (!running) break;

        pollController = new AbortController();
        const res = await fetchImpl(
          `${baseUrl}/tab/v1/poll?sessionId=${encodeURIComponent(sessionId)}`,
          {
            method: 'GET',
            headers: authHeaders(),
            signal: pollController.signal
          }
        );

        if (!running) break;

        if (res.status === 204) {
          continue;
        }

        if (res.status === 409) {
          // Relay restarted or session expired -> immediately re-hello
          sessionId = null;
          await hello();
          continue;
        }

        if (!res.ok) {
          updateState({
            status: 'error',
            error: `Poll failed with HTTP ${res.status}`
          });
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }

        const payload = await res.json();
        if (payload && payload.callId && payload.rpc) {
          await handleIncomingCall(payload.callId, payload.rpc);
        }
      } catch (err) {
        if (!running) break;
        if (err && err.name === 'AbortError') break;
        sessionId = null;
        updateState({
          status: err && (err.status === 401 || err.status === 403) ? 'rejected' : 'reconnecting',
          sessionId: null,
          error: err && err.message ? err.message : String(err)
        });
        if (err && (err.status === 401 || err.status === 403)) {
          running = false;
          break;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }

  async function start() {
    if (!mcpKey) {
      const reachable = await probeRelay({ mcpPort, host, fetchImpl });
      updateState({
        status: reachable ? 'awaiting-key' : 'offline',
        sessionId: null,
        error: null
      });
      return state;
    }

    if (running) return state;
    running = true;
    unsubscribeTools = modelContext.onToolsChanged((tools) => {
      pushTools(tools);
    });

    await hello();
    pollLoop();
    return state;
  }

  function stop() {
    running = false;
    if (unsubscribeTools) {
      unsubscribeTools();
      unsubscribeTools = null;
    }
    if (pollController) {
      pollController.abort();
      pollController = null;
    }
    updateState({ status: 'stopped', sessionId: null });
  }

  return {
    start,
    stop,
    hello,
    getState() {
      return state;
    }
  };
}
