import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizePageUrl, parseMcpRouteUrl } from '../web/url.mjs';
import { MCP_PROTOCOL_VERSION } from '../web/dispatch.mjs';
import { createStore, validateAllowToolSpec } from './store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = path.resolve(__dirname, '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

export function defaultOpenBrowser(targetUrl) {
  return new Promise((resolve) => {
    const platform = process.platform;
    const cmd =
      platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = platform === 'win32' ? ['/c', 'start', '', targetUrl] : [targetUrl];
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.unref();
      child.on('error', () => resolve(false));
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function extractBearerToken(req) {
  const auth = req.headers.authorization || '';
  if (typeof auth !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return match ? match[1].trim() : null;
}

export function createRelayServer({
  store = undefined,
  host = '127.0.0.1',
  port = 8788,
  pollTimeoutMs = 25000,
  reconnectGraceMs = 1500,
  connectTimeoutMs = 10000,
  execTimeoutMs = 30000,
  maxQueueSize = 32,
  rootDir = DEFAULT_ROOT_DIR,
  dashboardOrigins = [],
  openBrowser = defaultOpenBrowser,
  chatBackend = undefined,
  onSiteAdded = undefined,
  onSiteRemoved = undefined
} = {}) {
  const activeStore = store || createStore();

  // Map<sessionId, { sessionId, url, title, tools, createdAt, lastSeenAt, parkedPoll: { res, timer } | null }>
  const sessions = new Map();
  // Map<normalizedUrl, sessionId>
  const urlToSessionId = new Map();
  // Map<normalizedUrl, Array<PendingCall>>
  const pendingQueues = new Map();
  // Map<callId, PendingCall>
  const inFlightCalls = new Map();
  // Map<normalizedUrl, { openingPromise: Promise | null }>
  const tabLaunchers = new Map();

  let callCounter = 0;
  let boundPort = port;
  let server = null;

  // Rate limiter for POST /admin/v1/open-dashboard
  const openDashboardTimestamps = [];
  const OPEN_DASHBOARD_WINDOW_MS = 10000;
  const OPEN_DASHBOARD_MAX_CALLS = 3;

  function applyCorsHeaders(req, res) {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-AI-Proxy-Confirm'
    );
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  function sendJson(req, res, statusCode, payload, { cors = true, extraHeaders = {} } = {}) {
    if (res.writableEnded) return;
    if (cors) {
      applyCorsHeaders(req, res);
    }
    for (const [k, v] of Object.entries(extraHeaders)) {
      res.setHeader(k, v);
    }
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
  }

  function getQueue(normalizedUrl) {
    if (!pendingQueues.has(normalizedUrl)) {
      pendingQueues.set(normalizedUrl, []);
    }
    return pendingQueues.get(normalizedUrl);
  }

  function getActiveSessionForUrl(normalizedUrl) {
    const sid = urlToSessionId.get(normalizedUrl);
    if (!sid) return null;
    const ses = sessions.get(sid);
    if (!ses) {
      urlToSessionId.delete(normalizedUrl);
      return null;
    }
    return ses;
  }

  function dispatchNextCallIfPossible(normalizedUrl) {
    const ses = getActiveSessionForUrl(normalizedUrl);
    if (!ses || !ses.parkedPoll) return false;

    const queue = getQueue(normalizedUrl);
    if (queue.length === 0) return false;

    const nextCall = queue.shift();
    const { res: pollRes, req: pollReq, timer: pollTimer } = ses.parkedPoll;
    clearTimeout(pollTimer);
    ses.parkedPoll = null;
    ses.lastSeenAt = Date.now();

    nextCall.dispatchedToSessionId = ses.sessionId;
    sendJson(pollReq, pollRes, 200, {
      callId: nextCall.callId,
      rpc: nextCall.rewrittenRpc
    });
    return true;
  }

  async function ensureTabConnected(normalizedUrl) {
    if (getActiveSessionForUrl(normalizedUrl)) return;

    if (tabLaunchers.has(normalizedUrl)) {
      await tabLaunchers.get(normalizedUrl);
      return;
    }

    const launchTask = (async () => {
      // Wait reconnectGraceMs first so already-open tabs can re-hello after relay restart
      await new Promise((resolve) => {
        const t = setTimeout(resolve, reconnectGraceMs);
        const checkInterval = setInterval(() => {
          if (getActiveSessionForUrl(normalizedUrl)) {
            clearTimeout(t);
            clearInterval(checkInterval);
            resolve();
          }
        }, 15);
        setTimeout(() => clearInterval(checkInterval), reconnectGraceMs + 20);
      });

      if (getActiveSessionForUrl(normalizedUrl)) return;

      const pageKey = activeStore.getOrCreatePageKey(normalizedUrl);
      const launchUrl = `${normalizedUrl}#mcp-key=${encodeURIComponent(pageKey)}&mcp-port=${boundPort}`;
      await openBrowser(launchUrl);
    })();

    tabLaunchers.set(normalizedUrl, launchTask);
    try {
      await launchTask;
    } finally {
      tabLaunchers.delete(normalizedUrl);
    }
  }

  function enqueueTabCall(normalizedUrl, rpc, req, res) {
    const queue = getQueue(normalizedUrl);
    const inFlightForUrl = Array.from(inFlightCalls.values()).filter(
      (c) => c.normalizedUrl === normalizedUrl
    ).length;

    if (inFlightForUrl >= maxQueueSize) {
      sendJson(
        req,
        res,
        200,
        {
          jsonrpc: '2.0',
          id: rpc.id ?? null,
          error: {
            code: -32000,
            message: `Tab call queue full (max ${maxQueueSize})`
          }
        },
        { cors: false }
      );
      return;
    }

    callCounter += 1;
    const callId = `call_${callCounter}_${crypto.randomBytes(4).toString('hex')}`;
    const originalId = rpc.id;
    const rewrittenRpc = {
      ...rpc,
      id: callId
    };

    const callRecord = {
      callId,
      normalizedUrl,
      originalId,
      rewrittenRpc,
      acknowledged: false,
      dispatchedToSessionId: null,
      timer: null,
      finish(responsePayload) {
        if (!inFlightCalls.has(callId)) return;
        inFlightCalls.delete(callId);
        clearTimeout(callRecord.timer);
        const q = getQueue(normalizedUrl);
        const idx = q.indexOf(callRecord);
        if (idx !== -1) q.splice(idx, 1);

        const finalPayload = {
          ...responsePayload,
          jsonrpc: '2.0',
          id: originalId
        };
        sendJson(req, res, 200, finalPayload, { cors: false });
      }
    };

    callRecord.timer = setTimeout(() => {
      callRecord.finish({
        jsonrpc: '2.0',
        id: originalId,
        error: {
          code: -32001,
          message: `Timed out waiting for browser tab (${normalizedUrl})`
        }
      });
    }, connectTimeoutMs);

    inFlightCalls.set(callId, callRecord);
    queue.push(callRecord);

    if (!dispatchNextCallIfPossible(normalizedUrl)) {
      ensureTabConnected(normalizedUrl).catch(() => {});
    }
  }

  async function handleMcpRoute(req, res) {
    // Rule 3: /mcp rejects any request carrying an Origin header
    if (req.headers.origin) {
      sendJson(
        req,
        res,
        403,
        { error: 'Origin header is not allowed on /mcp (web pages cannot act as MCP clients)' },
        { cors: true }
      );
      return;
    }

    // Claude Code SSE GET probe -> 405 Method Not Allowed
    if (req.method === 'GET') {
      sendJson(
        req,
        res,
        405,
        { error: 'SSE GET is not supported on /mcp; use POST for JSON responses' },
        { cors: false, extraHeaders: { Allow: 'POST' } }
      );
      return;
    }

    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'Method not allowed' }, { cors: false, extraHeaders: { Allow: 'POST' } });
      return;
    }

    const targetUrl = parseMcpRouteUrl(req.url);
    if (!targetUrl) {
      sendJson(req, res, 400, { error: 'Invalid or missing target URL on /mcp' }, { cors: false });
      return;
    }

    // Rule 2: Verify target URL is in allowlist (or localhost)
    if (!activeStore.isUrlAllowed(targetUrl)) {
      sendJson(
        req,
        res,
        403,
        {
          error: `Target URL is not in allowlist: ${targetUrl}. Run "ai-proxy allow ${targetUrl}" first.`,
          url: targetUrl
        },
        { cors: false }
      );
      return;
    }

    let rpc;
    try {
      rpc = await readJsonBody(req);
    } catch (err) {
      sendJson(
        req,
        res,
        400,
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: err.message }
        },
        { cors: false }
      );
      return;
    }

    if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
      sendJson(
        req,
        res,
        400,
        {
          jsonrpc: '2.0',
          id: rpc && 'id' in rpc ? rpc.id : null,
          error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' }
        },
        { cors: false }
      );
      return;
    }

    // Claude Code probe: server/discover -> -32601
    if (rpc.method === 'server/discover') {
      sendJson(
        req,
        res,
        200,
        {
          jsonrpc: '2.0',
          id: rpc.id ?? null,
          error: { code: -32601, message: 'Method not found: server/discover' }
        },
        { cors: false }
      );
      return;
    }

    if (rpc.method === 'initialize') {
      sendJson(
        req,
        res,
        200,
        {
          jsonrpc: '2.0',
          id: rpc.id ?? null,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
              tools: { listChanged: true }
            },
            serverInfo: {
              name: 'ai-proxy',
              version: '1.0.0',
              pageUrl: targetUrl
            }
          }
        },
        { cors: false }
      );
      return;
    }

    if (rpc.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }

    if (rpc.method === 'ping') {
      sendJson(
        req,
        res,
        200,
        {
          jsonrpc: '2.0',
          id: rpc.id ?? null,
          result: {}
        },
        { cors: false }
      );
      return;
    }

    if (rpc.method === 'tools/list' || rpc.method === 'tools/call') {
      enqueueTabCall(targetUrl, rpc, req, res);
      return;
    }

    sendJson(
      req,
      res,
      200,
      {
        jsonrpc: '2.0',
        id: rpc.id ?? null,
        error: { code: -32601, message: `Method not found: ${rpc.method}` }
      },
      { cors: false }
    );
  }

  async function handleTabRoute(req, res, pathname, searchParams) {
    if (pathname === '/tab/v1/probe') {
      sendJson(req, res, 200, { ok: true, service: 'ai-proxy', version: '1.0.0' });
      return;
    }

    const token = extractBearerToken(req);

    if (pathname === '/tab/v1/hello' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(req, res, 400, { error: err.message });
        return;
      }

      let normalizedUrl;
      try {
        normalizedUrl = normalizePageUrl(body.url);
      } catch {
        sendJson(req, res, 400, { error: 'Invalid page URL in hello body' });
        return;
      }

      // Check allowlist prefix
      if (!activeStore.isUrlAllowed(normalizedUrl)) {
        sendJson(req, res, 403, { error: `Page URL is not in allowlist: ${normalizedUrl}` });
        return;
      }

      // Check Origin header matches page URL origin if Origin is present
      if (req.headers.origin) {
        const expectedOrigin = new URL(normalizedUrl).origin;
        if (req.headers.origin !== expectedOrigin) {
          sendJson(req, res, 403, {
            error: `Origin "${req.headers.origin}" does not match page origin "${expectedOrigin}"`
          });
          return;
        }
      }

      // Verify per-page key
      if (!activeStore.verifyPageKey(normalizedUrl, token)) {
        sendJson(req, res, 401, { error: 'Invalid or missing per-page mcp-key' });
        return;
      }

      // Replace any previous session for this URL
      const prevSid = urlToSessionId.get(normalizedUrl);
      if (prevSid && sessions.has(prevSid)) {
        const prevSes = sessions.get(prevSid);
        if (prevSes.parkedPoll) {
          clearTimeout(prevSes.parkedPoll.timer);
          sendJson(prevSes.parkedPoll.req, prevSes.parkedPoll.res, 204, {});
        }
        sessions.delete(prevSid);
      }

      const sessionId = `ses_${crypto.randomBytes(10).toString('hex')}`;
      const sessionObj = {
        sessionId,
        url: normalizedUrl,
        title: typeof body.title === 'string' ? body.title : '',
        tools: Array.isArray(body.tools) ? body.tools : [],
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        parkedPoll: null
      };

      sessions.set(sessionId, sessionObj);
      urlToSessionId.set(normalizedUrl, sessionId);
      activeStore.updateSiteTools(normalizedUrl, sessionObj.tools, sessionObj.title);

      sendJson(req, res, 200, {
        ok: true,
        sessionId,
        normalizedUrl,
        pollTimeoutMs
      });
      return;
    }

    if (pathname === '/tab/v1/poll' && req.method === 'GET') {
      const sessionId = searchParams.get('sessionId');
      if (!sessionId) {
        sendJson(req, res, 400, { error: 'Missing sessionId query parameter' });
        return;
      }

      const ses = sessions.get(sessionId);
      if (!ses) {
        // If token is completely missing, return 401; otherwise 409 Conflict so tab re-hellos
        if (!token) {
          sendJson(req, res, 401, { error: 'Missing Authorization Bearer token' });
          return;
        }
        sendJson(req, res, 409, { error: 'Unknown or expired sessionId; re-hello required' });
        return;
      }

      if (!activeStore.verifyPageKey(ses.url, token)) {
        sendJson(req, res, 401, { error: 'Invalid per-page mcp-key for session' });
        return;
      }

      if (!activeStore.isUrlAllowed(ses.url)) {
        sessions.delete(sessionId);
        urlToSessionId.delete(ses.url);
        sendJson(req, res, 403, { error: 'Site was removed from allowlist' });
        return;
      }

      ses.lastSeenAt = Date.now();

      // If previous poll was parked, close it cleanly
      if (ses.parkedPoll) {
        clearTimeout(ses.parkedPoll.timer);
        ses.parkedPoll = null;
      }

      const queue = getQueue(ses.url);
      if (queue.length > 0) {
        const nextCall = queue.shift();
        nextCall.dispatchedToSessionId = sessionId;
        sendJson(req, res, 200, {
          callId: nextCall.callId,
          rpc: nextCall.rewrittenRpc
        });
        return;
      }

      const timer = setTimeout(() => {
        if (ses.parkedPoll && ses.parkedPoll.res === res) {
          ses.parkedPoll = null;
        }
        if (!res.writableEnded) {
          applyCorsHeaders(req, res);
          res.writeHead(204);
          res.end();
        }
      }, pollTimeoutMs);

      ses.parkedPoll = { req, res, timer };
      req.on('close', () => {
        if (ses.parkedPoll && ses.parkedPoll.res === res) {
          clearTimeout(ses.parkedPoll.timer);
          ses.parkedPoll = null;
        }
      });
      return;
    }

    if (pathname === '/tab/v1/ack' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(req, res, 400, { error: err.message });
        return;
      }
      const ses = sessions.get(body.sessionId);
      if (!ses) {
        sendJson(req, res, 409, { error: 'Unknown sessionId' });
        return;
      }
      if (!activeStore.verifyPageKey(ses.url, token)) {
        sendJson(req, res, 401, { error: 'Invalid mcp-key' });
        return;
      }
      const callRecord = inFlightCalls.get(body.callId);
      if (!callRecord) {
        sendJson(req, res, 404, { error: 'Unknown callId' });
        return;
      }
      callRecord.acknowledged = true;
      clearTimeout(callRecord.timer);
      callRecord.timer = setTimeout(() => {
        callRecord.finish({
          jsonrpc: '2.0',
          id: callRecord.originalId,
          error: {
            code: -32001,
            message: `Tool execution timed out (${ses.url})`
          }
        });
      }, execTimeoutMs);

      sendJson(req, res, 200, { ok: true });
      return;
    }

    if (pathname === '/tab/v1/reply' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(req, res, 400, { error: err.message });
        return;
      }
      const ses = sessions.get(body.sessionId);
      if (!ses) {
        sendJson(req, res, 409, { error: 'Unknown sessionId' });
        return;
      }
      if (!activeStore.verifyPageKey(ses.url, token)) {
        sendJson(req, res, 401, { error: 'Invalid mcp-key' });
        return;
      }
      const callRecord = inFlightCalls.get(body.callId);
      if (!callRecord) {
        sendJson(req, res, 404, { error: 'Unknown or already completed callId' });
        return;
      }

      callRecord.finish(body.response || { result: {} });
      sendJson(req, res, 200, { ok: true });
      dispatchNextCallIfPossible(ses.url);
      return;
    }

    if (pathname === '/tab/v1/tools' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(req, res, 400, { error: err.message });
        return;
      }
      const ses = sessions.get(body.sessionId);
      if (!ses) {
        sendJson(req, res, 409, { error: 'Unknown sessionId' });
        return;
      }
      if (!activeStore.verifyPageKey(ses.url, token)) {
        sendJson(req, res, 401, { error: 'Invalid mcp-key' });
        return;
      }
      if (Array.isArray(body.tools)) {
        ses.tools = body.tools;
        activeStore.updateSiteTools(ses.url, ses.tools, ses.title);
      }
      sendJson(req, res, 200, { ok: true });
      return;
    }

    sendJson(req, res, 404, { error: 'Not found' });
  }

  function resolvePermittedV1Tools() {
    // Rule 7: When wildcard open-origin mode (*) is active, zero tools are exposed (pure chat only)
    if (activeStore.isOpenOriginActive()) {
      return [];
    }

    // Rule 4: Only tools explicitly named via --allow-tool mcp__<server>__<tool> AND readOnlyHint === true
    const allowedSpecs = activeStore.getAllowedTools();
    if (allowedSpecs.length === 0) return [];

    const parsedSpecs = [];
    for (const raw of allowedSpecs) {
      try {
        parsedSpecs.push(validateAllowToolSpec(raw));
      } catch {
        // Ignore invalid spec
      }
    }

    const allSites = activeStore.listSites();
    const permitted = [];

    for (const spec of parsedSpecs) {
      for (const site of allSites) {
        if (site.name !== spec.server) continue;
        const tool = (site.tools || []).find((t) => t.name === spec.tool);
        if (tool && tool.annotations && tool.annotations.readOnlyHint === true) {
          permitted.push({
            fullSpec: spec.full,
            server: spec.server,
            tool: tool.name,
            pageUrl: site.url,
            definition: tool
          });
        }
      }
    }

    return permitted;
  }

  async function handleV1Route(req, res, pathname) {
    const selfOrigins = [
      `http://127.0.0.1:${boundPort}`,
      `http://localhost:${boundPort}`,
      ...dashboardOrigins
    ];

    if (!activeStore.isV1OriginAllowed(req.headers.origin, selfOrigins)) {
      sendJson(req, res, 403, {
        error: `Origin "${req.headers.origin}" is not authorized to use /v1.`
      });
      return;
    }

    if (pathname === '/v1/models' && req.method === 'GET') {
      sendJson(req, res, 200, {
        object: 'list',
        data: [
          {
            id: 'local-default',
            object: 'model',
            created: 1700000000,
            owned_by: 'ai-proxy'
          }
        ]
      });
      return;
    }

    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(req, res, 400, { error: { message: err.message } });
        return;
      }

      const messages = Array.isArray(body.messages) ? body.messages : [];
      const permittedTools = resolvePermittedV1Tools();

      try {
        let replyText = '';
        if (typeof chatBackend === 'function') {
          replyText = await chatBackend({
            messages,
            model: body.model || 'local-default',
            permittedTools
          });
        } else {
          // Default built-in documentation assistant fallback if no external upstream is configured
          const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
          const promptText = lastUser && typeof lastUser.content === 'string' ? lastUser.content : '';
          replyText = `ai-proxy local assistant received: "${promptText}". Permitted read-only tools: [${permittedTools.map((t) => t.fullSpec).join(', ') || 'none'}].`;
        }

        sendJson(req, res, 200, {
          id: `chatcmpl_${crypto.randomBytes(8).toString('hex')}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model || 'local-default',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: String(replyText)
              },
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
          },
          ai_proxy: {
            openOriginMode: activeStore.isOpenOriginActive(),
            permittedReadOnlyTools: permittedTools.map((t) => t.fullSpec)
          }
        });
      } catch (err) {
        sendJson(req, res, 502, {
          error: {
            message: err && err.message ? err.message : 'Upstream chat backend failed'
          }
        });
      }
      return;
    }

    sendJson(req, res, 404, { error: 'Not found' });
  }

  async function handleAdminRoute(req, res, pathname) {
    // Rule 5: Unique unauthenticated admin route is POST /admin/v1/open-dashboard
    if (pathname === '/admin/v1/open-dashboard' && req.method === 'POST') {
      const allowedDashboardOrigins = [
        `http://127.0.0.1:${boundPort}`,
        `http://localhost:${boundPort}`,
        ...dashboardOrigins
      ];
      const reqOrigin = req.headers.origin;
      if (!reqOrigin || !allowedDashboardOrigins.includes(reqOrigin)) {
        sendJson(req, res, 403, {
          error: 'Forbidden: open-dashboard only accepts requests from the registered dashboard origin'
        });
        return;
      }

      const now = Date.now();
      while (
        openDashboardTimestamps.length > 0 &&
        now - openDashboardTimestamps[0] > OPEN_DASHBOARD_WINDOW_MS
      ) {
        openDashboardTimestamps.shift();
      }
      if (openDashboardTimestamps.length >= OPEN_DASHBOARD_MAX_CALLS) {
        sendJson(req, res, 429, {
          error: 'Rate limit exceeded for open-dashboard. Please wait a few seconds.'
        });
        return;
      }
      openDashboardTimestamps.push(now);

      const dashboardUrl = `http://127.0.0.1:${boundPort}/dashboard.html#admin-key=${encodeURIComponent(
        activeStore.getAdminKey()
      )}&mcp-port=${boundPort}`;
      await openBrowser(dashboardUrl);

      // Never return adminKey in the response body!
      sendJson(req, res, 200, { ok: true, opened: true });
      return;
    }

    // All other /admin/v1/* routes require Authorization: Bearer <admin-key>
    const token = extractBearerToken(req);
    if (!activeStore.verifyAdminKey(token)) {
      sendJson(req, res, 401, { error: 'Invalid or missing admin-key' });
      return;
    }

    if (pathname === '/admin/v1/status' && req.method === 'GET') {
      const snap = activeStore.getSnapshot();
      const sitesWithLive = snap.sites.map((s) => {
        const ses = getActiveSessionForUrl(s.url);
        return {
          ...s,
          connected: Boolean(ses),
          sessionId: ses ? ses.sessionId : null
        };
      });
      sendJson(req, res, 200, {
        ok: true,
        port: boundPort,
        ...snap,
        sites: sitesWithLive
      });
      return;
    }

    if (pathname === '/admin/v1/sites' && req.method === 'GET') {
      const sites = activeStore.listSites().map((s) => {
        const ses = getActiveSessionForUrl(s.url);
        return {
          ...s,
          connected: Boolean(ses),
          sessionId: ses ? ses.sessionId : null
        };
      });
      sendJson(req, res, 200, { ok: true, sites });
      return;
    }

    if (pathname === '/admin/v1/sites' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(req, res, 400, { error: err.message });
        return;
      }
      if (!body.url) {
        sendJson(req, res, 400, { error: 'Missing site url' });
        return;
      }
      let site;
      try {
        site = activeStore.addSite({ url: body.url, name: body.name });
      } catch (err) {
        sendJson(req, res, 400, { error: err.message });
        return;
      }
      if (typeof onSiteAdded === 'function') {
        try {
          await onSiteAdded(site, boundPort);
        } catch {
          // non-fatal
        }
      }
      if (body.openTab) {
        const launchUrl = `${site.url}#mcp-key=${encodeURIComponent(site.key)}&mcp-port=${boundPort}`;
        await openBrowser(launchUrl);
      }
      sendJson(req, res, 200, { ok: true, site });
      return;
    }

    if (pathname === '/admin/v1/sites' && req.method === 'DELETE') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(req, res, 400, { error: err.message });
        return;
      }
      if (!body.url) {
        sendJson(req, res, 400, { error: 'Missing site url' });
        return;
      }
      let normalized;
      try {
        normalized = normalizePageUrl(body.url);
      } catch (err) {
        sendJson(req, res, 400, { error: err.message });
        return;
      }
      const existing = activeStore.removeSite(normalized);
      const ses = getActiveSessionForUrl(normalized);
      if (ses) {
        if (ses.parkedPoll) {
          clearTimeout(ses.parkedPoll.timer);
          sendJson(ses.parkedPoll.req, ses.parkedPoll.res, 403, { error: 'Site removed' });
        }
        sessions.delete(ses.sessionId);
        urlToSessionId.delete(normalized);
      }
      if (typeof onSiteRemoved === 'function' && existing) {
        try {
          await onSiteRemoved(existing);
        } catch {
          // non-fatal
        }
      }
      sendJson(req, res, 200, { ok: true, removed: normalized });
      return;
    }

    if (pathname === '/admin/v1/allow' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const allowlist = activeStore.allowPrefix(body.prefix);
        sendJson(req, res, 200, { ok: true, allowlist });
      } catch (err) {
        sendJson(req, res, 400, { error: err.message });
      }
      return;
    }

    if (pathname === '/admin/v1/deny' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const allowlist = activeStore.denyPrefix(body.prefix);
        sendJson(req, res, 200, { ok: true, allowlist });
      } catch (err) {
        sendJson(req, res, 400, { error: err.message });
      }
      return;
    }

    if (pathname === '/admin/v1/origins' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const result =
          body.action === 'deny'
            ? activeStore.denyOrigin(body.origin)
            : activeStore.allowOrigin(body.origin, { ttlSeconds: body.ttlSeconds });
        sendJson(req, res, 200, {
          ok: true,
          ...result,
          warnings: activeStore.getWarnings()
        });
      } catch (err) {
        sendJson(req, res, 400, { error: err.message });
      }
      return;
    }

    if (pathname === '/admin/v1/keys/rotate' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const rotated = activeStore.rotateKeys({
          url: body.url,
          rotateAdmin: Boolean(body.rotateAdmin)
        });
        sendJson(req, res, 200, { ok: true, rotated });
      } catch (err) {
        sendJson(req, res, 400, { error: err.message });
      }
      return;
    }

    sendJson(req, res, 404, { error: 'Not found' });
  }

  function serveStaticFile(req, res, pathname) {
    let relPath = pathname;
    if (relPath === '/' || relPath === '') {
      relPath = '/index.html';
    } else if (relPath === '/dashboard' || relPath === '/dashboard/') {
      relPath = '/dashboard.html';
    } else if (relPath.startsWith('/dashboard/')) {
      relPath = relPath.slice('/dashboard'.length);
    } else if (relPath === '/mcp') {
      relPath = '/mcp.html';
    }

    const safeRel = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const fullPath = path.resolve(rootDir, `.${safeRel.startsWith('/') ? safeRel : `/${safeRel}`}`);
    if (!fullPath.startsWith(path.resolve(rootDir))) {
      sendJson(req, res, 403, { error: 'Forbidden path' });
      return;
    }

    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      sendJson(req, res, 404, { error: `Static file not found: ${pathname}` });
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = fs.readFileSync(fullPath);
    applyCorsHeaders(req, res);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  }

  async function requestListener(req, res) {
    const parsedUrl = new URL(req.url || '/', `http://${host}:${boundPort}`);
    const { pathname, searchParams } = parsedUrl;

    if (req.method === 'OPTIONS') {
      applyCorsHeaders(req, res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/healthz') {
      sendJson(req, res, 200, {
        ok: true,
        service: 'ai-proxy',
        version: '1.0.0',
        warnings: activeStore.getWarnings()
      });
      return;
    }

    if (pathname === '/mcp' || pathname.startsWith('/mcp/')) {
      await handleMcpRoute(req, res);
      return;
    }

    if (pathname.startsWith('/tab/v1/')) {
      await handleTabRoute(req, res, pathname, searchParams);
      return;
    }

    if (pathname.startsWith('/v1/')) {
      await handleV1Route(req, res, pathname);
      return;
    }

    if (pathname.startsWith('/admin/v1/')) {
      await handleAdminRoute(req, res, pathname);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStaticFile(req, res, pathname);
      return;
    }

    sendJson(req, res, 404, { error: 'Not found' });
  }

  async function start() {
    if (server) {
      return { host, port: boundPort };
    }
    server = http.createServer((req, res) => {
      requestListener(req, res).catch((err) => {
        sendJson(req, res, 500, {
          error: err && err.message ? err.message : 'Internal server error'
        });
      });
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        const addr = server.address();
        boundPort = typeof addr === 'object' && addr ? addr.port : port;
        resolve();
      });
    });

    return { host, port: boundPort };
  }

  async function stop() {
    for (const ses of sessions.values()) {
      if (ses.parkedPoll) {
        clearTimeout(ses.parkedPoll.timer);
        if (!ses.parkedPoll.res.writableEnded) {
          ses.parkedPoll.res.writeHead(204);
          ses.parkedPoll.res.end();
        }
      }
    }
    sessions.clear();
    urlToSessionId.clear();

    for (const call of inFlightCalls.values()) {
      clearTimeout(call.timer);
    }
    inFlightCalls.clear();
    pendingQueues.clear();

    if (!server) return;
    const s = server;
    server = null;
    await new Promise((resolve) => s.close(() => resolve()));
  }

  return {
    store: activeStore,
    start,
    stop,
    getPort() {
      return boundPort;
    }
  };
}
