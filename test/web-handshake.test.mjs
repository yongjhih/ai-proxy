import test from 'node:test';
import assert from 'node:assert/strict';
import { extractHandshake } from '../web/handshake.mjs';

function createMockWindow(href, initialState = null) {
  let currentUrl = new URL(href);
  let state = initialState;
  const replaceCalls = [];

  const forbiddenStorage = new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`Security violation: storage property "${String(prop)}" must never be accessed`);
      },
      set(_target, prop) {
        throw new Error(`Security violation: storage property "${String(prop)}" must never be written`);
      }
    }
  );

  return {
    get location() {
      return {
        get href() {
          return currentUrl.toString();
        },
        get pathname() {
          return currentUrl.pathname;
        },
        get search() {
          return currentUrl.search;
        },
        get hash() {
          return currentUrl.hash;
        },
        get origin() {
          return currentUrl.origin;
        }
      };
    },
    history: {
      get state() {
        return state;
      },
      replaceState(newState, title, url) {
        state = newState;
        if (url !== undefined && url !== null) {
          currentUrl = new URL(url, currentUrl.origin);
        }
        replaceCalls.push({ newState, title, url: currentUrl.toString() });
      }
    },
    localStorage: forbiddenStorage,
    sessionStorage: forbiddenStorage,
    get replaceCalls() {
      return replaceCalls;
    }
  };
}

test('extractHandshake moves mcp-key and mcp-port from hash into history.state and scrubs URL', () => {
  const win = createMockWindow(
    'https://example.github.io/docs/mcp.html?tool=about#mcp-key=sec_12345&mcp-port=9123',
    { existingUserKey: 'keep-me' }
  );

  const hs = extractHandshake(win);

  assert.equal(hs.mcpKey, 'sec_12345');
  assert.equal(hs.mcpPort, 9123);
  assert.equal(hs.adminKey, null);
  assert.equal(win.location.hash, '');
  assert.equal(win.location.href, 'https://example.github.io/docs/mcp.html?tool=about');
  assert.equal(win.history.state.existingUserKey, 'keep-me');
  assert.equal(win.history.state.__aiProxy.mcpKey, 'sec_12345');
  assert.equal(win.history.state.__aiProxy.mcpPort, 9123);
  assert.equal(win.replaceCalls.length, 1);
});

test('extractHandshake recovers keys from history.state on subsequent reload without hash', () => {
  const win = createMockWindow('https://example.github.io/docs/mcp.html', {
    __aiProxy: {
      mcpKey: 'sec_persisted',
      mcpPort: 8788,
      adminKey: null
    }
  });

  const hs = extractHandshake(win);

  assert.equal(hs.mcpKey, 'sec_persisted');
  assert.equal(hs.mcpPort, 8788);
  assert.equal(win.replaceCalls.length, 0);
});

test('extractHandshake extracts admin-key and preserves unrelated hash parameters', () => {
  const win = createMockWindow(
    'http://127.0.0.1:8788/dashboard.html#admin-key=adm_999&mcp-port=8788&tab=sites'
  );

  const hs = extractHandshake(win);

  assert.equal(hs.adminKey, 'adm_999');
  assert.equal(hs.mcpPort, 8788);
  assert.equal(win.location.hash, '#tab=sites');
  assert.equal(win.history.state.__aiProxy.adminKey, 'adm_999');
});
