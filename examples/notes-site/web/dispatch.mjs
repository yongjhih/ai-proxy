/**
 * Converts WebMCP ModelContext tools into an MCP JSON-RPC 2.0 dispatcher.
 */

export const MCP_PROTOCOL_VERSION = '2025-11-25';

export function formatToolResult(value) {
  if (
    value &&
    typeof value === 'object' &&
    Array.isArray(value.content) &&
    value.content.every((c) => c && typeof c.type === 'string')
  ) {
    return {
      content: value.content,
      isError: Boolean(value.isError)
    };
  }

  const text =
    typeof value === 'string'
      ? value
      : value === undefined
        ? 'null'
        : JSON.stringify(value, null, 2);

  return {
    content: [{ type: 'text', text }],
    isError: false
  };
}

export function createMcpDispatcher(modelContext, serverInfo = {}) {
  if (!modelContext || typeof modelContext.listTools !== 'function') {
    throw new TypeError('createMcpDispatcher requires a valid ModelContext instance');
  }

  const inFlight = new Map();
  const info = {
    name: serverInfo.name || 'mcp-page',
    version: serverInfo.version || '1.0.0',
    ...(serverInfo.pageUrl ? { pageUrl: serverInfo.pageUrl } : {})
  };

  async function handle(rpc) {
    if (!rpc || typeof rpc !== 'object' || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
      return {
        jsonrpc: '2.0',
        id: rpc && 'id' in rpc ? rpc.id : null,
        error: { code: -32600, message: 'Invalid Request' }
      };
    }

    const { id, method, params } = rpc;
    const isNotification = id === undefined;

    if (method === 'notifications/initialized') {
      return null;
    }

    if (method === 'notifications/cancelled') {
      const reqId = params && params.requestId;
      if (reqId !== undefined && inFlight.has(String(reqId))) {
        const ctrl = inFlight.get(String(reqId));
        inFlight.delete(String(reqId));
        ctrl.abort((params && params.reason) || 'Cancelled by client');
      }
      return null;
    }

    if (isNotification) {
      return null;
    }

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: true }
          },
          serverInfo: info
        }
      };
    }

    if (method === 'ping') {
      return {
        jsonrpc: '2.0',
        id,
        result: {}
      };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: modelContext.listTools()
        }
      };
    }

    if (method === 'tools/call') {
      const toolName = params && params.name;
      const toolArgs = params && params.arguments !== undefined ? params.arguments : {};
      if (typeof toolName !== 'string' || !toolName) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'Missing tool name in params.name' }
        };
      }

      const controller = new AbortController();
      const key = String(id);
      inFlight.set(key, controller);

      try {
        const output = await modelContext.callTool(toolName, toolArgs, {
          signal: controller.signal
        });
        return {
          jsonrpc: '2.0',
          id,
          result: formatToolResult(output)
        };
      } catch (err) {
        if (err && (err.code === -32800 || err.name === 'AbortError' || controller.signal.aborted)) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32800,
              message: err.message || 'Request cancelled'
            }
          };
        }
        if (err && err.code === -32602) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32602,
              message: err.message
            }
          };
        }
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: err && err.message ? err.message : String(err) }],
            isError: true
          }
        };
      } finally {
        inFlight.delete(key);
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`
      }
    };
  }

  return {
    handle
  };
}
