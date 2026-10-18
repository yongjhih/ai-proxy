import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateDefaultAssistantReply, createRelayServer } from '../src/relay.mjs';
import { createStore } from '../src/store.mjs';
import { formatAssistantMarkdown, initAskAiDrawer, generateClientAssistantReply } from '../site/ask-ai.mjs';

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

  // 8. Knowledge
  const knowledgeReply = generateDefaultAssistantReply('查看 ai-proxy 知識與架構 knowledge');
  assert.ok(knowledgeReply.includes('知識庫概覽'));
  assert.ok(knowledgeReply.includes('doc.html?d=spec'));
  assert.ok(knowledgeReply.includes('mcp.html?tool=knowledge'));

  // 9. CLI & Skills
  const skillsReply = generateDefaultAssistantReply('如何安裝 CLI 與 agent skills');
  assert.ok(skillsReply.includes('npx ai-proxy serve'));
  assert.ok(skillsReply.includes('claude mcp add'));
  assert.ok(skillsReply.includes('skills/mcp-pages/SKILL.md'));
  assert.ok(skillsReply.includes('mcp.html?tool=cli_skills'));

  // 10. Site Tour
  const tourReply = generateDefaultAssistantReply('請給我網站導覽 tour');
  assert.ok(tourReply.includes('網站導覽地圖'));
  assert.ok(tourReply.includes('index.html'));
  assert.ok(tourReply.includes('mcp.html?tool=site_tour'));

  // 11. Dashboard
  const dashReply = generateDefaultAssistantReply('打開 dashboard 控制台');
  assert.ok(dashReply.includes('dashboard.html'));
  assert.ok(dashReply.includes('#details-allow-prefix'));

  // 12. Fallback includes permitted read-only tools
  const fallbackReply = generateDefaultAssistantReply('隨意問話', [
    { fullSpec: 'mcp__ai-proxy__about' },
    { fullSpec: 'mcp__ai-proxy__knowledge' }
  ]);
  assert.ok(fallbackReply.includes('Permitted read-only tools: [mcp__ai-proxy__about, mcp__ai-proxy__knowledge].'));
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
    'knowledge',
    'cli_skills',
    'site_tour',
    'add_mcp',
    'add_site',
    'remove_mcp',
    'remove_site',
    'allow_origin',
    'add_allow_origin',
    'deny_origin',
    'remove_allow_origin',
    'allow_prefix',
    'deny_prefix',
    'set_site_permission'
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

test('/v1/chat/completions fallback provides default permitted read-only tools instead of none', async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-v1-default-'));
  const store = createStore({ configDir: tmpHome });
  const relay = createRelayServer({
    store,
    port: 0,
    openBrowser: async () => {}
  });
  const { port } = await relay.start();
  t.after(async () => {
    await relay.stop();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Origin: 'http://127.0.0.1',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Random unhandled prompt' }]
    })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.ai_proxy.permittedReadOnlyTools.length > 0);
  assert.ok(data.ai_proxy.permittedReadOnlyTools.includes('mcp__ai-proxy__about'));
  assert.ok(data.ai_proxy.permittedReadOnlyTools.includes('mcp__ai-proxy__knowledge'));
  assert.ok(data.ai_proxy.permittedReadOnlyTools.includes('mcp__ai-proxy__cli_skills'));
  assert.ok(data.ai_proxy.permittedReadOnlyTools.includes('mcp__ai-proxy__site_tour'));

  const content = data.choices[0].message.content;
  assert.ok(!content.includes('Permitted read-only tools: [none]'));
  assert.ok(content.includes('mcp__ai-proxy__knowledge'));
});

test('generateDefaultAssistantReply and generateClientAssistantReply answer "mcp 是什麼？" with comprehensive explanation and action buttons', () => {
  const queries = ['mcp 是什麼？', '什麼是 mcp', 'what is mcp', 'ai-proxy 是什麼', '什麼是 ai-proxy', 'MCP 概念與原理'];

  for (const q of queries) {
    const relayReply = generateDefaultAssistantReply(q);
    assert.ok(relayReply.includes('Model Context Protocol'), `Failed for query "${q}" in relayReply`);
    assert.ok(relayReply.includes('ai-proxy'), `Missing ai-proxy in relayReply for "${q}"`);
    assert.ok(relayReply.includes('doc.html?d=spec'), `Missing spec link in relayReply for "${q}"`);
    assert.ok(relayReply.includes('doc.html?d=security'), `Missing security link in relayReply for "${q}"`);
    assert.ok(relayReply.includes('#quickstart'), `Missing quickstart link in relayReply for "${q}"`);
    assert.ok(!relayReply.includes('Permitted read-only tools: [none]'), `Must not fallback to none for "${q}"`);

    const clientReply = generateClientAssistantReply(q, 'zh-TW');
    assert.ok(clientReply.includes('Model Context Protocol'), `Failed for query "${q}" in clientReply`);
    assert.ok(clientReply.includes('#quickstart'), `Missing quickstart in clientReply for "${q}"`);
    assert.ok(clientReply.includes('mcp.html'), `Missing mcp.html in clientReply for "${q}"`);
  }

  const enReply = generateClientAssistantReply('what is mcp?', 'en');
  assert.ok(enReply.includes('Model Context Protocol'));
  assert.ok(enReply.includes('zero-dependency local relay'));
  assert.ok(enReply.includes('#quickstart'));
});

test('initAskAiDrawer renders greeting with interactive chips when history is empty, and clear button restores chips', () => {
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
      addEventListener(event, fn) {
        if (!el._listeners) el._listeners = new Map();
        el._listeners.set(event, fn);
      },
      dispatchEvent(event) {
        if (el._listeners && el._listeners.has(event.type)) {
          el._listeners.get(event.type)(event);
        }
      },
      focus() {},
      scrollIntoView() {},
      closest(sel) {
        if (sel === '.ask-ai-chip' && el._isChip) return el;
        return null;
      },
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
    sessionStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {}
    },
    location: { href: 'http://localhost/index.html', origin: 'http://localhost' }
  };

  const drawerCtrl = initAskAiDrawer({ lang: 'zh-TW', win: fakeWin });
  assert.ok(drawerCtrl);

  // When history is empty, messagesEl should contain the greeting with chips
  assert.equal(messagesEl.children.length, 1);
  const greetingEl = messagesEl.children[0];
  assert.ok(greetingEl.innerHTML.includes('ask-ai-chips'));
  assert.ok(greetingEl.innerHTML.includes('data-ask="mcp 是什麼？"'));
  assert.ok(greetingEl.innerHTML.includes('data-ask="快速上手指南"'));
});

test('formatAssistantMarkdown renders full markdown headers, horizontal rule, bold, italic, and lists', () => {
  const md = [
    '### 常見指令速覽',
    '---',
    '**啟動轉送服務** 支援 *斜體* 與 ~~刪除線~~：',
    '1. 第一步執行 `npx ai-proxy`',
    '2. 第二步在瀏覽器開啟',
    '',
    '- 無序列表項目'
  ].join('\n');

  const html = formatAssistantMarkdown(md);
  assert.ok(html.includes('<h3>常見指令速覽</h3>'), 'Should render h3');
  assert.ok(html.includes('<hr />'), 'Should render hr');
  assert.ok(html.includes('<strong>啟動轉送服務</strong>'), 'Should render bold');
  assert.ok(html.includes('<em>斜體</em>'), 'Should render italic');
  assert.ok(html.includes('<del>刪除線</del>'), 'Should render strikethrough');
  assert.ok(html.includes('<ol>'), 'Should render ordered list <ol>');
  assert.ok(html.includes('<li>第一步執行 <code>npx ai-proxy</code></li>'), 'Should render ol li');
  assert.ok(html.includes('</ol>'), 'Should close ordered list </ol>');
  assert.ok(html.includes('<ul>'), 'Should render unordered list <ul>');
});

test('initAskAiDrawer renders raw toggle button and hidden raw markdown container for assistant messages', () => {
  const store = new Map();
  const fakeSessionStorage = {
    getItem(k) { return store.get(k) || null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); }
  };
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

  fakeSessionStorage.setItem(
    'ai_proxy_ask_ai_history',
    JSON.stringify([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '### Title\n\n**Bold response**' }
    ])
  );

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
    localStorage: {
      getItem(k) { return k === 'ai_proxy_endpoint' ? 'http://127.0.0.1:9099' : null; },
      setItem() {},
      removeItem() {}
    },
    location: { href: 'http://localhost/doc.html' }
  };

  const drawerCtrl = initAskAiDrawer({ lang: 'en', win: fakeWin });
  assert.ok(drawerCtrl);
  assert.equal(typeof drawerCtrl.updateConnectionStatus, 'function');

  // Verify assistant message contains raw toggle button and both rendered and raw content containers
  const assistantBubble = messagesEl.children[1];
  assert.ok(assistantBubble.innerHTML.includes('class="ask-ai-raw-toggle"'));
  assert.ok(assistantBubble.innerHTML.includes('class="ask-ai-rendered-content"'));
  assert.ok(assistantBubble.innerHTML.includes('class="ask-ai-raw-content"'));
  assert.ok(assistantBubble.innerHTML.includes('### Title'));
  assert.ok(assistantBubble.innerHTML.includes('<h3>Title</h3>'));
  assert.ok(assistantBubble.innerHTML.includes('<strong>Bold response</strong>'));
});



