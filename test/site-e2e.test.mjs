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

      // 1. Verify root / & /zh-TW short URLs at desktop and mobile widths
      await navigateAndCheck('', 1280, 900, 'index-desktop.png');
      const indexQuickstart = await page.evalJs(
        `document.querySelector('[data-replace-base-url="true"]').textContent`
      );
      assert.ok(indexQuickstart.includes(`${baseUrl}/mcp --name ai-proxy`), 'index base URL replaced');
      assert.ok(
        await page.evalJs(`Boolean(document.querySelector('#home-dashboard-root #btn-connect-dashboard'))`),
        'Home page renders live ai-proxy dashboard panel'
      );
      assert.ok(
        await page.evalJs(`Boolean(document.querySelector('pre code .syn-cmd'))`),
        'Code blocks have syntax highlighting applied'
      );

      // Test theme toggle buttons and dark/light Mermaid re-rendering on root /
      await page.evalJs(`document.querySelector('[data-theme-mode="dark"]').click()`);
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(await page.evalJs(`document.documentElement.getAttribute('data-theme')`), 'dark');
      if (screenshotDir) {
        await page.send('Emulation.setDeviceMetricsOverride', {
          width: 1280,
          height: 1450,
          deviceScaleFactor: 1,
          mobile: false
        });
        const shot = await page.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(screenshotDir, 'index-dark.png'), Buffer.from(shot.data, 'base64'));
      }
      const mermaidSvgText = await page.evalJs(`document.querySelector('.mermaid').textContent`);
      assert.ok(mermaidSvgText.includes('mcp-key'), 'Mermaid diagram preserves mcp-key without # comment truncation');
      await page.evalJs(`document.querySelector('[data-theme-mode="light"]').click()`);
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(await page.evalJs(`document.documentElement.getAttribute('data-theme')`), 'light');

      await navigateAndCheck('', 390, 844, 'index-mobile.png');
      await navigateAndCheck('zh-TW', 1280, 900, 'zh-TW-desktop.png');
      await navigateAndCheck('zh-TW', 390, 844, 'zh-TW-mobile.png');

      // 2. Verify /doc?d=... short URL SPA navigation across topics and languages
      await navigateAndCheck('doc?d=index', 1280, 900, 'doc-desktop.png');
      await page.evalJs(`document.querySelector('a[data-doc="spec"]').click()`);
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(await page.evalJs(`window.location.pathname`), '/doc');
      assert.equal(await page.evalJs(`window.location.search`), '?d=spec');
      assert.ok((await page.evalJs(`document.getElementById('doc-content').textContent`)).includes('MCP Pages'));

      await page.evalJs(`document.querySelector('a[data-doc="security"]').click()`);
      await new Promise((r) => setTimeout(r, 350));
      assert.equal(await page.evalJs(`window.location.pathname`), '/doc');
      assert.equal(await page.evalJs(`window.location.search`), '?d=security');
      await page.evalJs(`document.querySelector('[data-theme-mode="dark"]').click()`);
      await new Promise((r) => setTimeout(r, 400));
      if (screenshotDir) {
        await page.send('Emulation.setDeviceMetricsOverride', {
          width: 1280,
          height: 1450,
          deviceScaleFactor: 1,
          mobile: false
        });
        const shot = await page.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(screenshotDir, 'doc-security-dark.png'), Buffer.from(shot.data, 'base64'));
      }

      await page.evalJs(`document.querySelector('a[data-doc="zh-TW/security"]').click()`);
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(await page.evalJs(`window.location.pathname`), '/doc');
      assert.equal(await page.evalJs(`window.location.search`), '?d=zh-TW%2Fsecurity');
      await navigateAndCheck('doc?d=zh-TW/security', 390, 844, 'doc-mobile.png');

      // Verify /covpages/ coverage report page loads cleanly
      const covRes = await fetch(`${baseUrl}/covpages/`);
      assert.equal(covRes.status, 200);
      const badgeRes = await fetch(`${baseUrl}/covpages/badge.svg`);
      assert.equal(badgeRes.status, 200);

      // 3. Verify /dashboard short URL unauthenticated Connect button redirects and unlocks in place
      await navigateAndCheck('dashboard', 1280, 900, 'dashboard-unauth-desktop.png');
      await page.evalJs(`document.getElementById('btn-connect-dashboard').click()`);
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(
        await page.evalJs(`window.history.state.__aiProxy.adminKey`),
        relay.store.getAdminKey(),
        'Clicking Connect must redirect and unlock adminKey in-place'
      );

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
      assert.ok(
        (await page.evalJs(`document.querySelector('#dashboard-root h2').textContent`)).includes('MCP sites'),
        'Heading must be MCP sites (N)'
      );
      assert.ok(
        await page.evalJs(`Boolean(document.querySelector('#details-allow-prefix summary'))`),
        'URL Prefix Allowlist is folded inside details'
      );
      assert.ok(
        await page.evalJs(`Boolean(document.querySelector('#details-allowed-origins summary'))`),
        'Chat Completions Allowed Origins is folded inside details'
      );

      const isCheckboxChecked = await page.evalJs(
        `Boolean(document.getElementById('checkbox-add-site-write')?.checked)`
      );
      assert.equal(isCheckboxChecked, true, 'Write checkbox must be checked by default');

      const isOriginCheckboxChecked = await page.evalJs(
        `Boolean(document.getElementById('checkbox-add-site-origin')?.checked)`
      );
      assert.equal(isOriginCheckboxChecked, true, 'Allow Origin checkbox must be checked by default');

      // Click Add Site (using directory URL to test automatic /mcp endpoint, prefix, and origin allowance)
      await page.evalJs(`
        (() => {
          const form = document.getElementById('form-add-site');
          form.querySelector('input[name="url"]').value = 'https://example.github.io/demo/';
          form.querySelector('input[name="name"]').value = 'demo-site';
          form.requestSubmit();
        })()
      `);

      let added = false;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const text = await page.evalJs(`document.getElementById('dashboard-root').textContent`);
        if (text.includes('demo-site')) {
          added = true;
          break;
        }
      }
      assert.ok(added, 'Site must appear in dashboard after addSite');
      assert.ok(
        relay.store.getSnapshot().allowlist.includes('https://example.github.io/demo/'),
        'Directory prefix automatically allowed'
      );
      assert.ok(
        relay.store.getSnapshot().allowedOrigins.includes('https://example.github.io'),
        'Site origin automatically allowed on /v1'
      );
      const demoSite = relay.store.getSite('https://example.github.io/demo/mcp');
      assert.equal(demoSite.write, true, 'MCP site added via dashboard form must have write: true by default');

      // Toggle mode button: switch to read-only
      await page.evalJs(`(() => {
        const btn = document.querySelector('tr[data-site-url="https://example.github.io/demo/mcp"] .btn-toggle-site-mode');
        if (btn) btn.click();
      })()`);
      await new Promise((r) => setTimeout(r, 200));
      const demoSiteAfterToggle = relay.store.getSite('https://example.github.io/demo/mcp');
      assert.equal(demoSiteAfterToggle.write, false, 'Site mode should be toggled to read-only');

      // Toggle origin button: revoke origin
      await page.evalJs(`(() => {
        const btn = document.querySelector('tr[data-site-url="https://example.github.io/demo/mcp"] .btn-toggle-site-origin');
        if (btn) btn.click();
      })()`);
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(
        !relay.store.getSnapshot().allowedOrigins.includes('https://example.github.io'),
        'Origin revoked via table button'
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

      // 5. Open /mcp with #mcp-key & #admin-key and invoke all 6 tools through POST /mcp (and verify /mcp <-> /mcp.html equivalence)
      const selfMcpUrl = `${baseUrl}/mcp`;
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

      async function callRelayTool(name, args = {}, targetUrlOverride = selfMcpUrl) {
        const res = await fetch(`${baseUrl}/mcp?url=${encodeURIComponent(targetUrlOverride)}`, {
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

      // Call 1: about (via short /mcp)
      const aboutOut = await callRelayTool('about');
      assert.equal(aboutOut.name, 'ai-proxy');
      assert.equal(aboutOut.adminAuthenticated, true);

      // Call 1b: about (via equivalent /mcp.html against the same /mcp tab session)
      const aboutHtmlOut = await callRelayTool('about', {}, `${baseUrl}/mcp.html`);
      assert.equal(aboutHtmlOut.name, 'ai-proxy');

      // Call 2: sites
      const sitesOut = await callRelayTool('sites');
      assert.equal(sitesOut.authenticated, true);
      assert.ok(Array.isArray(sitesOut.sites));

      // Call 3: site_tools
      const siteToolsOut = await callRelayTool('site_tools', {});
      assert.equal(siteToolsOut.tools.length, 18);

      // Call 4: spec
      const specOut = await callRelayTool('spec', { topic: 'security', lang: 'zh-TW' });
      assert.equal(specOut.topic, 'security');
      assert.equal(specOut.lang, 'zh-TW');
      assert.ok(specOut.markdown.includes('安全模型'));
      assert.ok(!specOut.markdown.includes('https://<host>/<org>/<repo>/'));

      // Call 4a: knowledge
      const knowledgeOut = await callRelayTool('knowledge', { topic: 'security', lang: 'zh-TW' });
      assert.equal(knowledgeOut.topic, 'security');
      assert.equal(knowledgeOut.lang, 'zh-TW');
      assert.ok(knowledgeOut.data.baselines.length >= 7);

      // Call 4b: cli_skills
      const skillsOut = await callRelayTool('cli_skills', { client: 'cli', lang: 'zh-TW' });
      assert.equal(skillsOut.client, 'cli');
      assert.ok(skillsOut.guide.commands.length > 0);

      // Call 4c: site_tour
      const tourOut = await callRelayTool('site_tour', { lang: 'zh-TW' });
      assert.ok(Array.isArray(tourOut.pages));
      assert.ok(tourOut.pages.length >= 5);

      // Call 5: add_site
      const addSiteOut = await callRelayTool('add_site', {
        url: 'https://example.github.io/added-via-tool/mcp.html',
        name: 'added-via-tool'
      });
      assert.equal(addSiteOut.ok, true);
      assert.equal(addSiteOut.site.name, 'added-via-tool');
      assert.equal(addSiteOut.site.write, true);

      // Call 6: remove_site
      const removeSiteOut = await callRelayTool('remove_site', {
        url: 'https://example.github.io/added-via-tool/mcp.html'
      });
      assert.equal(removeSiteOut.ok, true);
      assert.equal(
        removeSiteOut.removed,
        'https://example.github.io/added-via-tool/mcp.html'
      );

      // Call 7: add_mcp (alias of add_site)
      const addMcpOut = await callRelayTool('add_mcp', {
        url: 'https://example.github.io/added-via-mcp-tool/mcp',
        name: 'added-mcp'
      });
      assert.equal(addMcpOut.ok, true);
      assert.equal(addMcpOut.site.name, 'added-mcp');
      assert.equal(addMcpOut.site.write, true);

      // Call 8: remove_mcp (alias of remove_site)
      const removeMcpOut = await callRelayTool('remove_mcp', {
        url: 'https://example.github.io/added-via-mcp-tool/mcp'
      });
      assert.equal(removeMcpOut.ok, true);

      // Call 9: allow_origin
      const allowOriginOut = await callRelayTool('allow_origin', {
        origin: 'https://custom-origin.example.com'
      });
      assert.equal(allowOriginOut.ok, true);
      assert.ok(allowOriginOut.allowedOrigins.includes('https://custom-origin.example.com'));

      // Call 10: deny_origin
      const denyOriginOut = await callRelayTool('deny_origin', {
        origin: 'https://custom-origin.example.com'
      });
      assert.equal(denyOriginOut.ok, true);
      assert.ok(!denyOriginOut.allowedOrigins.includes('https://custom-origin.example.com'));

      // Call 11: allow_prefix
      const allowPrefixOut = await callRelayTool('allow_prefix', {
        prefix: 'https://custom-prefix.example.com/'
      });
      assert.equal(allowPrefixOut.ok, true);
      assert.ok(allowPrefixOut.allowlist.includes('https://custom-prefix.example.com/'));

      // Call 12: deny_prefix
      const denyPrefixOut = await callRelayTool('deny_prefix', {
        prefix: 'https://custom-prefix.example.com/'
      });
      assert.equal(denyPrefixOut.ok, true);
      assert.ok(!denyPrefixOut.allowlist.includes('https://custom-prefix.example.com/'));

      // Call 13: set_site_permission
      const setPermOut = await callRelayTool('set_site_permission', {
        url: selfMcpUrl,
        write: false
      });
      assert.equal(setPermOut.ok, true);
      assert.equal(setPermOut.site.write, false);

      // Test Ask AI drawer in dashboard: submit query, render CTA button, and click CTA to add site
      await page.evalJs(`
        document.getElementById('ask-ai-trigger').click();
        const input = document.getElementById('ask-ai-input');
        input.value = '新增 mcp https://example.github.io/e2e-ask-site/mcp';
        document.getElementById('ask-ai-form').dispatchEvent(new Event('submit'));
      `);
      await new Promise((r) => setTimeout(r, 600));

      const ctaBtnText = await page.evalJs(`(() => {
        const btn = document.querySelector('.ask-ai-cta-btn');
        return btn ? btn.textContent : '';
      })()`);
      assert.ok(ctaBtnText.includes('新增 MCP'), `Expected CTA button to appear, got: ${ctaBtnText}`);

      // Click the CTA button to add the MCP site from Ask AI
      await page.evalJs(`(() => {
        const btn = document.querySelector('.ask-ai-cta-btn');
        if (btn) btn.click();
      })()`);
      await new Promise((r) => setTimeout(r, 600));

      const siteAddedInTable = await page.evalJs(`(() => {
        return document.querySelector('tr[data-site-url="https://example.github.io/e2e-ask-site/mcp"]') !== null;
      })()`);
      assert.equal(siteAddedInTable, true, 'Site added via Ask AI CTA button must appear in dashboard table');

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
      if (chrome?.proc) {
        if (chrome.proc.exitCode === null) {
          try {
            chrome.proc.kill('SIGTERM');
          } catch {}
          const killTimer = setTimeout(() => {
            try {
              chrome.proc.kill('SIGKILL');
            } catch {}
          }, 1500);
          await new Promise((resolve) => {
            if (chrome.proc.exitCode !== null) return resolve();
            chrome.proc.once('exit', resolve);
          });
          clearTimeout(killTimer);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      await relay.stop();
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
      } catch {}
      try {
        fs.rmSync(chromeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
      } catch {}
    }
  }
);
