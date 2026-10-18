import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRelayServer } from '../src/relay.mjs';
import { renderMarkdownToHtml, replaceBaseUrlPlaceholder } from '../site/doc-reader.mjs';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('All 5 HTML pages have inline theme/base-URL script, color-scheme meta, and pinned Mermaid SRI', () => {
  const htmlFiles = ['index.html', 'zh-TW.html', 'doc.html', 'dashboard.html', 'mcp.html'];
  for (const file of htmlFiles) {
    const content = fs.readFileSync(path.join(ROOT_DIR, file), 'utf8');
    assert.ok(content.includes('<meta name="color-scheme" content="light dark" />'), `${file} missing color-scheme`);
    assert.ok(content.includes("localStorage.getItem('ai-proxy-theme')"), `${file} missing inline theme init`);
    assert.ok(
      content.includes('replace(/https:\\/\\/<host>\\/<org>\\/<repo>\\//g'),
      `${file} missing inline base URL replacement`
    );
  }

  for (const mermaidPage of ['index.html', 'zh-TW.html', 'doc.html']) {
    const content = fs.readFileSync(path.join(ROOT_DIR, mermaidPage), 'utf8');
    assert.ok(
      content.includes('https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js'),
      `${mermaidPage} missing pinned mermaid 11.4.1`
    );
    assert.ok(
      content.includes('sha384-rbtjAdnIQE/aQJGEgXrVUlMibdfTSa4PQju4HDhN3sR2PmaKFzhEafuePsl9H/9I'),
      `${mermaidPage} missing mermaid SHA-384 SRI`
    );
  }
});

test('doc-reader renderMarkdownToHtml substitutes runtime base URL and renders tables and mermaid blocks', () => {
  const md = [
    '# Spec Title',
    '',
    'Run `npx ai-proxy add https://<host>/<org>/<repo>/mcp.html`',
    '',
    '| Col A | Col B |',
    '| --- | --- |',
    '| Val 1 | Val 2 |',
    '',
    '```mermaid',
    'graph TD',
    '  A --> B',
    '```'
  ].join('\n');

  const html = renderMarkdownToHtml(md, 'https://yongjhih.github.io/ai-proxy/');
  assert.ok(html.includes('<h1>Spec Title</h1>'));
  assert.ok(html.includes('https://yongjhih.github.io/ai-proxy/mcp.html'));
  assert.ok(!html.includes('https://<host>/<org>/<repo>/'));
  assert.ok(html.includes('<table class="data-table">'));
  assert.ok(html.includes('<div class="mermaid">'));

  assert.equal(
    replaceBaseUrlPlaceholder('Visit https://<host>/<org>/<repo>/doc.html', 'http://127.0.0.1:9999'),
    'Visit http://127.0.0.1:9999/doc.html'
  );
});

async function launchChromeWithCdp(userDataDir) {
  const proc = spawn(
    CHROME_BIN,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${userDataDir}`,
      '--remote-debugging-port=0',
      'about:blank'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const wsUrl = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Chrome launch timeout. stderr: ${stderr}`)), 10000);
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (${code}): ${stderr}`));
    });
  });

  const debugPort = new URL(wsUrl).port;
  return { proc, debugPort, wsUrl };
}

async function connectTargetCdp(debugPort, targetUrl = 'about:blank') {
  const res = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(targetUrl)}`, {
    method: 'PUT'
  });
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const consoleErrors = [];
  const pageExceptions = [];

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const text = (msg.params.args || []).map((a) => a.value || a.description || '').join(' ');
      consoleErrors.push(text);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const details = msg.params.exceptionDetails;
      pageExceptions.push(details.text || (details.exception && details.exception.description) || 'exception');
    }
  });

  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await send('Page.enable');
  await send('Runtime.enable');

  async function evalJs(expression) {
    const out = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (out.exceptionDetails) {
      throw new Error(
        `JS exception: ${out.exceptionDetails.text} ${
          (out.exceptionDetails.exception && out.exceptionDetails.exception.description) || ''
        }`
      );
    }
    return out.result ? out.result.value : undefined;
  }

  return {
    send,
    evalJs,
    consoleErrors,
    pageExceptions,
    close: () => ws.close()
  };
}

test(
  'Real browser E2E: verify all pages, doc SPA, all dashboard buttons, and all 6 built-in MCP tools via relay',
  { skip: !fs.existsSync(CHROME_BIN) },
  async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-e2e-home-'));
    const chromeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-chrome-'));
    const openedUrls = [];

    const relay = createRelayServer({
      port: 0,
      homeDir: tmpHome,
      rootDir: ROOT_DIR,
      openBrowser: async (url) => {
        openedUrls.push(url);
      }
    });
    const { port } = await relay.start();
    const baseUrl = `http://127.0.0.1:${port}`;
    const screenshotDir = process.env.AI_PROXY_SCREENSHOT_DIR || '';

    const chrome = await launchChromeWithCdp(chromeDir);
    try {
      const page = await connectTargetCdp(chrome.debugPort);

      async function navigateAndCheck(urlPath, width = 1280, height = 900, screenshotName = '') {
        await page.send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: width < 768
        });
        await page.send('Page.navigate', { url: `${baseUrl}/${urlPath}` });
        await new Promise((r) => setTimeout(r, 450));
        if (screenshotDir && screenshotName) {
          fs.mkdirSync(screenshotDir, { recursive: true });
          const shot = await page.send('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(path.join(screenshotDir, screenshotName), Buffer.from(shot.data, 'base64'));
        }
      }

      // 1. Verify index.html & zh-TW.html at desktop and mobile widths
      await navigateAndCheck('index.html', 1280, 900, 'index-desktop.png');
      const indexQuickstart = await page.evalJs(
        `document.querySelector('[data-replace-base-url="true"]').textContent`
      );
      assert.ok(indexQuickstart.includes(`${baseUrl}/mcp.html`), 'index.html base URL replaced');

      // Test theme toggle buttons on index.html
      await page.evalJs(`document.querySelector('[data-theme-mode="dark"]').click()`);
      assert.equal(await page.evalJs(`document.documentElement.getAttribute('data-theme')`), 'dark');
      await page.evalJs(`document.querySelector('[data-theme-mode="light"]').click()`);
      assert.equal(await page.evalJs(`document.documentElement.getAttribute('data-theme')`), 'light');

      await navigateAndCheck('index.html', 390, 844, 'index-mobile.png');
      await navigateAndCheck('zh-TW.html', 1280, 900, 'zh-TW-desktop.png');
      await navigateAndCheck('zh-TW.html', 390, 844, 'zh-TW-mobile.png');

      // 2. Verify doc.html SPA navigation across topics and languages
      await navigateAndCheck('doc.html?d=index', 1280, 900, 'doc-desktop.png');
      await page.evalJs(`document.querySelector('a[data-doc="spec"]').click()`);
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(await page.evalJs(`window.location.search`), '?d=spec');
      assert.ok((await page.evalJs(`document.getElementById('doc-content').textContent`)).includes('MCP Pages'));

      await page.evalJs(`document.querySelector('a[data-doc="zh-TW/security"]').click()`);
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(await page.evalJs(`window.location.search`), '?d=zh-TW%2Fsecurity');
      await navigateAndCheck('doc.html?d=zh-TW/security', 390, 844, 'doc-mobile.png');

      // 3. Verify dashboard.html unauthenticated Connect button
      await navigateAndCheck('dashboard.html', 1280, 900, 'dashboard-unauth-desktop.png');
      await page.evalJs(`document.getElementById('btn-connect-dashboard').click()`);
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(openedUrls.length, 1);
      assert.ok(openedUrls[0].includes('#admin-key='));

      // 4. Open authenticated dashboard.html and click every single button
      const adminKey = relay.store.getAdminKey();
      await navigateAndCheck(
        `dashboard.html#admin-key=${adminKey}&mcp-port=${port}`,
        1280,
        900,
        'dashboard-auth-desktop.png'
      );
      assert.equal(await page.evalJs(`window.location.hash`), '');
      assert.equal(await page.evalJs(`window.history.state.__aiProxy.adminKey`), adminKey);

      // Click Add Site
      await page.evalJs(`
        (() => {
          const form = document.getElementById('form-add-site');
          form.querySelector('input[name="url"]').value = 'https://example.github.io/demo/mcp.html';
          form.querySelector('input[name="name"]').value = 'demo-site';
          form.requestSubmit();
        })()
      `);
      await new Promise((r) => setTimeout(r, 250));
      assert.ok(
        (await page.evalJs(`document.getElementById('dashboard-root').textContent`)).includes('demo-site')
      );

      // Click Rotate single site key
      await page.evalJs(`document.querySelector('.btn-rotate-site').click()`);
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(
        (await page.evalJs(`document.getElementById('admin-feedback').textContent`)).includes('Rotated key')
      );

      // Click Remove site
      await page.evalJs(`document.querySelector('.btn-remove-site').click()`);
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(
        (await page.evalJs(`document.getElementById('admin-feedback').textContent`)).includes('Removed site')
      );

      // Click Allow Prefix & Deny Prefix
      await page.evalJs(`
        (() => {
          const form = document.getElementById('form-allow-prefix');
          form.querySelector('input[name="prefix"]').value = 'https://example.github.io/docs/';
          form.requestSubmit();
        })()
      `);
      await new Promise((r) => setTimeout(r, 200));
      await page.evalJs(`document.querySelector('.btn-deny-prefix').click()`);
      await new Promise((r) => setTimeout(r, 200));

      // Click Allow Origin & Revoke Origin
      await page.evalJs(`
        (() => {
          const form = document.getElementById('form-allow-origin');
          form.querySelector('input[name="origin"]').value = 'https://example.github.io';
          form.requestSubmit();
        })()
      `);
      await new Promise((r) => setTimeout(r, 200));
      await page.evalJs(`document.querySelector('.btn-deny-origin').click()`);
      await new Promise((r) => setTimeout(r, 200));

      // Click Enable Wildcard (*) Mode -> verify warning banner -> Click Disable Wildcard (*) Mode
      await page.evalJs(`document.getElementById('btn-enable-open-origin').click()`);
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(
        await page.evalJs(`Boolean(document.querySelector('[data-testid="open-origin-warning"]'))`),
        'Open origin warning banner must be rendered when * is active'
      );
      await page.evalJs(`document.getElementById('btn-disable-open-origin').click()`);
      await new Promise((r) => setTimeout(r, 200));

      // Click Rotate All Site Keys
      await page.evalJs(`document.getElementById('btn-rotate-all-keys').click()`);
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(
        (await page.evalJs(`document.getElementById('admin-feedback').textContent`)).includes('Rotated')
      );

      await navigateAndCheck(
        `dashboard.html#admin-key=${adminKey}&mcp-port=${port}`,
        390,
        844,
        'dashboard-auth-mobile.png'
      );

      // 5. Open mcp.html with #mcp-key & #admin-key and invoke all 6 tools through POST /mcp
      const selfMcpUrl = `${baseUrl}/mcp.html`;
      const siteRecord = relay.store.addSite({ url: selfMcpUrl, name: 'self-mcp' });
      const mcpTargetUrl = `${selfMcpUrl}#mcp-key=${siteRecord.key}&admin-key=${adminKey}&mcp-port=${port}`;

      const mcpTab = await connectTargetCdp(chrome.debugPort, mcpTargetUrl);
      await new Promise((r) => setTimeout(r, 600));
      assert.equal(await mcpTab.evalJs(`window.location.hash`), '');
      assert.equal(await mcpTab.evalJs(`window.history.state.__aiProxy.mcpKey`), siteRecord.key);

      if (screenshotDir) {
        await mcpTab.send('Emulation.setDeviceMetricsOverride', {
          width: 1280,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false
        });
        const shotDesktop = await mcpTab.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(screenshotDir, 'mcp-desktop.png'), Buffer.from(shotDesktop.data, 'base64'));

        await mcpTab.send('Emulation.setDeviceMetricsOverride', {
          width: 390,
          height: 844,
          deviceScaleFactor: 1,
          mobile: true
        });
        const shotMobile = await mcpTab.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(screenshotDir, 'mcp-mobile.png'), Buffer.from(shotMobile.data, 'base64'));
      }

      async function callRelayTool(name, args = {}) {
        const res = await fetch(`${baseUrl}/mcp?url=${encodeURIComponent(selfMcpUrl)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args }
          })
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(!body.error, `Unexpected RPC error calling ${name}: ${JSON.stringify(body.error)}`);
        assert.equal(body.result.isError, false, `Tool ${name} returned isError:true: ${JSON.stringify(body.result)}`);
        return JSON.parse(body.result.content[0].text);
      }

      // Call 1: about
      const aboutOut = await callRelayTool('about');
      assert.equal(aboutOut.name, 'ai-proxy');
      assert.equal(aboutOut.adminAuthenticated, true);

      // Call 2: sites
      const sitesOut = await callRelayTool('sites');
      assert.equal(sitesOut.authenticated, true);
      assert.ok(Array.isArray(sitesOut.sites));

      // Call 3: site_tools
      const siteToolsOut = await callRelayTool('site_tools', {});
      assert.equal(siteToolsOut.tools.length, 6);

      // Call 4: spec
      const specOut = await callRelayTool('spec', { topic: 'security', lang: 'zh-TW' });
      assert.equal(specOut.topic, 'security');
      assert.equal(specOut.lang, 'zh-TW');
      assert.ok(specOut.markdown.includes('安全模型'));
      assert.ok(!specOut.markdown.includes('https://<host>/<org>/<repo>/'));

      // Call 5: add_site
      const addSiteOut = await callRelayTool('add_site', {
        url: 'https://example.github.io/added-via-tool/mcp.html',
        name: 'added-via-tool'
      });
      assert.equal(addSiteOut.ok, true);
      assert.equal(addSiteOut.site.name, 'added-via-tool');

      // Call 6: remove_site
      const removeSiteOut = await callRelayTool('remove_site', {
        url: 'https://example.github.io/added-via-tool/mcp.html'
      });
      assert.equal(removeSiteOut.ok, true);
      assert.equal(
        removeSiteOut.removed,
        'https://example.github.io/added-via-tool/mcp.html'
      );

      // Also test Rotate Admin Key button last (since it invalidates the old adminKey)
      await page.evalJs(`document.getElementById('btn-rotate-admin-key').click()`);
      await new Promise((r) => setTimeout(r, 200));

      assert.deepEqual(page.consoleErrors, [], `Unexpected console errors on page: ${page.consoleErrors.join('; ')}`);
      assert.deepEqual(page.pageExceptions, [], `Unexpected exceptions on page: ${page.pageExceptions.join('; ')}`);
      assert.deepEqual(
        mcpTab.consoleErrors,
        [],
        `Unexpected console errors on mcp.html: ${mcpTab.consoleErrors.join('; ')}`
      );
      assert.deepEqual(
        mcpTab.pageExceptions,
        [],
        `Unexpected exceptions on mcp.html: ${mcpTab.pageExceptions.join('; ')}`
      );

      mcpTab.close();
      page.close();
    } finally {
      chrome.proc.kill('SIGTERM');
      await new Promise((resolve) => chrome.proc.once('exit', resolve));
      await relay.stop();
      fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      fs.rmSync(chromeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
);
