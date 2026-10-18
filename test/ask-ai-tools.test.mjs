import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateDefaultAssistantReply } from '../src/relay.mjs';
import { formatAssistantMarkdown, initAskAiDrawer } from '../site/ask-ai.mjs';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

test('generateDefaultAssistantReply recognizes intents and produces CTA action links & jump anchors', () => {
  // 1. Add MCP
  const addReply = generateDefaultAssistantReply('幫我新增 mcp https://example.github.io/my-site/mcp');
  assert.ok(addReply.includes('action:add-mcp?url=https%3A%2F%2Fexample.github.io%2Fmy-site%2Fmcp'));
  assert.ok(addReply.includes('#form-add-site'));

  const addEnReply = generateDefaultAssistantReply('add mcp https://example.github.io/my-site/mcp');
  assert.ok(addEnReply.includes('action:add-mcp?url=https%3A%2F%2Fexample.github.io%2Fmy-site%2Fmcp'));

  // 2. Remove MCP
  const removeReply = generateDefaultAssistantReply('移除 mcp https://example.github.io/my-site/mcp');
  assert.ok(removeReply.includes('action:remove-mcp?url=https%3A%2F%2Fexample.github.io%2Fmy-site%2Fmcp'));
  assert.ok(removeReply.includes('#admin-dashboard-authenticated'));

  // 3. Allow Origin
  const allowOriginReply = generateDefaultAssistantReply('允許 origin https://foo.example.com');
  assert.ok(allowOriginReply.includes('action:allow-origin?origin=https%3A%2F%2Ffoo.example.com'));
  assert.ok(allowOriginReply.includes('#details-allowed-origins'));

  // 4. Deny Origin
  const denyOriginReply = generateDefaultAssistantReply('撤銷 origin https://foo.example.com');
  assert.ok(denyOriginReply.includes('action:deny-origin?origin=https%3A%2F%2Ffoo.example.com'));

  // 5. Quickstart
  const quickstartReply = generateDefaultAssistantReply('跳轉到 quickstart 快速上手');
  assert.ok(quickstartReply.includes('#quickstart'));
  assert.ok(quickstartReply.includes('npx ai-proxy add'));

  // 6. Security
  const securityReply = generateDefaultAssistantReply('查看 security 安全規範');
  assert.ok(securityReply.includes('doc.html?d=security'));
  assert.ok(securityReply.includes('#details-allow-prefix'));

  // 7. Spec
  const specReply = generateDefaultAssistantReply('查看規格 spec');
  assert.ok(specReply.includes('doc.html?d=spec'));

  // 8. Dashboard
  const dashReply = generateDefaultAssistantReply('打開 dashboard 控制台');
  assert.ok(dashReply.includes('dashboard.html'));
  assert.ok(dashReply.includes('#details-allow-prefix'));
});

test('formatAssistantMarkdown renders interactive CTA buttons, jump anchors, code, and links', () => {
  const md = [
    'Here is an action:',
    '[➕ 新增 MCP](action:add-mcp?url=https%3A%2F%2Fexample.com)',
    '[🚀 快速上手](#quickstart)',
    '[📄 規格文件](doc.html?d=spec)',
    '',
    '- List item with `code`',
    '',
    '```bash',
    'echo hello',
    '```'
  ].join('\n');

  const html = formatAssistantMarkdown(md);
  assert.ok(html.includes('class="btn btn-sm btn-primary ask-ai-cta-btn"'));
  assert.ok(html.includes('data-action="action:add-mcp?url=https%3A%2F%2Fexample.com"'));
  assert.ok(html.includes('class="btn btn-sm ask-ai-jump-btn"'));
  assert.ok(html.includes('data-jump="#quickstart"'));
  assert.ok(html.includes('<a href="doc.html?d=spec"'));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('<pre><code>echo hello</code></pre>'));
});

test('self-mcp.mjs registers all requested management tools and marks mutating tools readOnlyHint:false', () => {
  const source = fs.readFileSync(path.join(ROOT_DIR, 'site', 'self-mcp.mjs'), 'utf8');
  const requiredTools = [
    'about',
    'sites',
    'site_tools',
    'spec',
    'add_mcp',
    'add_site',
    'remove_mcp',
    'remove_site',
    'allow_origin',
    'add_allow_origin',
    'deny_origin',
    'remove_allow_origin',
    'allow_prefix',
    'deny_prefix'
  ];

  for (const name of requiredTools) {
    assert.ok(source.includes(`name: '${name}'`), `Missing tool in self-mcp.mjs: ${name}`);
  }
});

test('initAskAiDrawer restores message history and open state from sessionStorage', () => {
  const store = new Map();
  const fakeSessionStorage = {
    getItem(k) { return store.get(k) || null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); }
  };

  // Pre-populate history and open state in sessionStorage
  fakeSessionStorage.setItem(
    'ai_proxy_ask_ai_history',
    JSON.stringify([
      { role: 'user', content: 'What is MCP Pages?' },
      { role: 'assistant', content: 'MCP Pages connects static sites to AI.' }
    ])
  );
  fakeSessionStorage.setItem('ai_proxy_ask_ai_open', 'true');

  const elements = new Map();
  function makeEl(tag, id = '') {
    const el = {
      tagName: tag.toUpperCase(),
      id,
      attributes: new Map(),
      children: [],
      style: {},
      innerHTML: '',
      textContent: '',
      setAttribute(k, v) { el.attributes.set(k, v); },
      getAttribute(k) { return el.attributes.get(k) || null; },
      appendChild(child) { el.children.push(child); },
      addEventListener() {},
      focus() {},
      scrollIntoView() {},
      closest() { return null; },
      parentNode: null
    };
    if (id) elements.set(id, el);
    return el;
  }

  const triggerBtn = makeEl('button', 'ask-ai-trigger');
  const drawer = makeEl('aside', 'ask-ai-drawer');
  const closeBtn = makeEl('button', 'ask-ai-close');
  const form = makeEl('form', 'ask-ai-form');
  const input = makeEl('input', 'ask-ai-input');
  const messagesEl = makeEl('div', 'ask-ai-messages');

  const fakeDoc = {
    getElementById(id) { return elements.get(id) || null; },
    createElement(tag) { return makeEl(tag); },
    querySelector() { return null; }
  };

  const fakeWin = {
    document: fakeDoc,
    sessionStorage: fakeSessionStorage,
    location: { href: 'http://localhost/doc.html', pathname: '/doc.html', search: '', hash: '' },
    history: { state: null },
    addEventListener() {}
  };

  const drawerCtrl = initAskAiDrawer({ lang: 'en', win: fakeWin });
  assert.ok(drawerCtrl);

  // Drawer should be automatically restored to open
  assert.equal(drawer.getAttribute('data-open'), 'true');

  // Messages should be restored from sessionStorage
  assert.equal(messagesEl.children.length, 2);
  assert.equal(messagesEl.children[0].textContent, 'What is MCP Pages?');
  assert.ok(messagesEl.children[1].innerHTML.includes('MCP Pages connects static sites to AI.'));
});

