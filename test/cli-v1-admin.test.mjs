import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createStore } from '../src/store.mjs';
import { createRelayServer } from '../src/relay.mjs';
import { runCli } from '../src/cli.mjs';

function makeTempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-cli-test-'));
  const homeDir = path.join(root, 'home');
  const configDir = path.join(root, 'config');
  const binDir = path.join(root, 'bin');
  const claudeLog = path.join(root, 'claude-calls.log');

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  // Create fake `claude` binary that records all arguments to claude-calls.log
  const fakeClaudePath = path.join(binDir, 'claude');
  fs.writeFileSync(
    fakeClaudePath,
    `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(claudeLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write('fake-claude-ok\\n');
`,
    { mode: 0o755 }
  );

  return {
    root,
    homeDir,
    configDir,
    binDir,
    fakeClaudePath,
    claudeLog,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

async function execCli(args, envObj, { stdinText = '' } = {}) {
  let stdout = '';
  let stderr = '';

  const stdin = Readable.from(stdinText ? [stdinText] : []);
  const stdoutStream = new Writable({
    write(chunk, _enc, cb) {
      stdout += chunk.toString();
      cb();
    }
  });
  const stderrStream = new Writable({
    write(chunk, _enc, cb) {
      stderr += chunk.toString();
      cb();
    }
  });

  const code = await runCli(args, {
    env: {
      HOME: envObj.homeDir,
      AI_PROXY_HOME: envObj.configDir,
      AI_PROXY_CLAUDE_BIN: envObj.fakeClaudePath,
      AI_PROXY_NO_BROWSER: '1'
    },
    stdin,
    stdout: stdoutStream,
    stderr: stderrStream
  });

  return { code, stdout, stderr };
}

test('/v1 enforces Origin allowlist, per-tool readOnlyHint filtering (Rule 4), and pure-chat wildcard mode with TTL (Rule 7)', async (t) => {
  const env = makeTempEnv();
  const store = createStore({ configDir: env.configDir });

  // Register a site with one read-only tool and one mutating tool
  const siteUrl = 'https://example.github.io/docs/mcp.html';
  store.addSite({ url: siteUrl, name: 'docs-site' });
  store.updateSiteTools(siteUrl, [
    {
      name: 'read_spec',
      description: 'Read specification',
      annotations: { readOnlyHint: true }
    },
    {
      name: 'delete_site',
      description: 'Delete site',
      annotations: { readOnlyHint: false }
    }
  ]);

  // Rule 4: Wildcards or whole-server specs in --allow-tool must throw
  assert.throws(() => store.setAllowedTools(['mcp__docs-site__*']), /wildcards are forbidden/i);
  assert.throws(() => store.setAllowedTools(['mcp__docs-site']), /must match mcp__<server>__<tool>/i);

  // Even if the user names BOTH read_spec and delete_site via --allow-tool,
  // /v1 must ONLY expose read_spec because delete_site has readOnlyHint: false!
  store.setAllowedTools(['mcp__docs-site__read_spec', 'mcp__docs-site__delete_site']);

  const relay = createRelayServer({
    store,
    port: 0,
    openBrowser: async () => {}
  });
  const { port } = await relay.start();
  t.after(async () => {
    await relay.stop();
    env.cleanup();
  });

  // 1. Unauthorized Origin is rejected with 403 + CORS headers
  const unauthRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Origin: 'https://untrusted.example.com',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
  });
  assert.equal(unauthRes.status, 403);
  assert.equal(unauthRes.headers.get('access-control-allow-origin'), 'https://untrusted.example.com');

  // 2. Explicitly allow https://example.github.io -> only read_spec is permitted, delete_site is blocked!
  store.allowOrigin('https://example.github.io');
  const authRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Origin: 'https://example.github.io',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Explain spec' }] })
  }).then((r) => r.json());

  assert.deepEqual(authRes.ai_proxy.permittedReadOnlyTools, ['mcp__docs-site__read_spec']);
  assert.equal(authRes.ai_proxy.openOriginMode, false);

  // 3. Rule 7: Enable open-origin mode (*) with short TTL -> pure chat (ZERO tools!) and loud warnings
  store.allowOrigin('*', { ttlSeconds: 0.15 });
  assert.equal(store.getWarnings().length, 1);

  const wildcardRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Origin: 'https://any-random-site.example.org',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] })
  }).then((r) => r.json());

  assert.equal(wildcardRes.ai_proxy.openOriginMode, true);
  assert.deepEqual(
    wildcardRes.ai_proxy.permittedReadOnlyTools,
    [],
    'Open-origin (*) mode must strictly expose 0 tools'
  );

  // Wait for TTL to expire -> random origin is rejected again (403)
  await new Promise((r) => setTimeout(r, 200));
  const expiredRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Origin: 'https://any-random-site.example.org',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello again' }] })
  });
  assert.equal(expiredRes.status, 403);
});

test('/admin/v1 enforces separate adminKey, origin-locked rate-limited open-dashboard without leaking key (Rule 5)', async (t) => {
  const env = makeTempEnv();
  const store = createStore({ configDir: env.configDir });
  const pageKey = store.getOrCreatePageKey('https://example.github.io/docs/mcp.html');
  const adminKey = store.getAdminKey();

  const openedUrls = [];
  const relay = createRelayServer({
    store,
    port: 0,
    dashboardOrigins: ['https://example.github.io'],
    openBrowser: async (u) => {
      openedUrls.push(u);
    }
  });
  const { port } = await relay.start();
  t.after(async () => {
    await relay.stop();
    env.cleanup();
  });

  // 1. Per-page mcp-key CANNOT access /admin/v1/status (401)
  const pageKeyAdminAttempt = await fetch(`http://127.0.0.1:${port}/admin/v1/status`, {
    headers: { Authorization: `Bearer ${pageKey}` }
  });
  assert.equal(pageKeyAdminAttempt.status, 401);

  // 2. open-dashboard rejects non-dashboard Origin (403)
  const badOriginOpen = await fetch(`http://127.0.0.1:${port}/admin/v1/open-dashboard`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example.com' }
  });
  assert.equal(badOriginOpen.status, 403);
  assert.equal(openedUrls.length, 0);

  // 3. open-dashboard from registered Origin opens dashboard URL with #admin-key in fragment,
  //    NEVER returns adminKey in response body, and rate-limits after 3 calls (429)
  for (let i = 0; i < 3; i += 1) {
    const okOpen = await fetch(`http://127.0.0.1:${port}/admin/v1/open-dashboard`, {
      method: 'POST',
      headers: { Origin: 'https://example.github.io' }
    });
    assert.equal(okOpen.status, 200);
    const bodyText = await okOpen.text();
    assert.equal(bodyText.includes(adminKey), false, 'Response body must NEVER contain adminKey');
  }
  assert.equal(openedUrls.length, 3);
  assert.ok(openedUrls[0].includes(`#admin-key=${encodeURIComponent(adminKey)}`));

  const rateLimitedOpen = await fetch(`http://127.0.0.1:${port}/admin/v1/open-dashboard`, {
    method: 'POST',
    headers: { Origin: 'https://example.github.io' }
  });
  assert.equal(rateLimitedOpen.status, 429);

  // 3b. open-dashboard GET forwards add-url parameter into redirect Location hash
  const getOpenWithAdd = await fetch(
    `http://127.0.0.1:${port}/admin/v1/open-dashboard?redirect=https%3A%2F%2Fexample.github.io%2Fdocs%2F&add-url=https%3A%2F%2Fexample.github.io%2Fcovpages%2Fmcp`,
    { redirect: 'manual' }
  );
  assert.equal(getOpenWithAdd.status, 302);
  const redirLocation = getOpenWithAdd.headers.get('location');
  assert.ok(redirLocation.includes(`#admin-key=${encodeURIComponent(adminKey)}`));
  assert.ok(redirLocation.includes('&add-url=https%3A%2F%2Fexample.github.io%2Fcovpages%2Fmcp'));

  // 4. Valid adminKey accesses /admin/v1/status, /admin/v1/sites, /admin/v1/keys/rotate
  const statusRes = await fetch(`http://127.0.0.1:${port}/admin/v1/status`, {
    headers: { Authorization: `Bearer ${adminKey}` }
  }).then((r) => r.json());
  assert.equal(statusRes.ok, true);
  assert.equal(statusRes.port, port);
});

test('CLI subcommands: allow, allow-origin, deny, add, sites, remove, vendor, keys rotate, open, install --login, doctor, mcp --url', async (t) => {
  const env = makeTempEnv();
  t.after(() => env.cleanup());

  // 1. allow <prefix>
  const allowRes = await execCli(['allow', 'https://example.github.io/docs/'], env);
  assert.equal(allowRes.code, 0);
  const allowData = JSON.parse(allowRes.stdout);
  assert.equal(allowData.ok, true);
  assert.ok(allowData.allowlist.includes('https://example.github.io/docs/'));

  // 2. allow-origin "*" --ttl 60 (must warn on stderr)
  const originRes = await execCli(['allow-origin', '*', '--ttl', '60'], env);
  assert.equal(originRes.code, 0);
  assert.match(originRes.stderr, /WARNING/i);
  assert.equal(JSON.parse(originRes.stdout).openOriginMode.enabled, true);

  // 3. deny "*" --origin
  const denyOriginRes = await execCli(['deny', '*', '--origin'], env);
  assert.equal(denyOriginRes.code, 0);
  assert.equal(JSON.parse(denyOriginRes.stdout).openOriginMode.enabled, false);

  // 4. add <url> --name my-docs (uses fake claude and temp configDir)
  const addRes = await execCli(
    ['add', 'https://example.github.io/docs/mcp.html', '--name', 'my-docs', '--port', '8788'],
    env
  );
  assert.equal(addRes.code, 0);
  const addData = JSON.parse(addRes.stdout);
  assert.equal(addData.name, 'my-docs');
  const claudeCallsAfterAdd = fs
    .readFileSync(env.claudeLog, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(claudeCallsAfterAdd.length, 1);
  assert.deepEqual(claudeCallsAfterAdd[0].slice(0, 4), ['mcp', 'add', '--transport', 'http']);

  // 5. sites (pipeable JSON output)
  const sitesRes = await execCli(['sites', '--json'], env);
  assert.equal(sitesRes.code, 0);
  const sitesList = JSON.parse(sitesRes.stdout);
  assert.equal(sitesList.length, 1);
  assert.equal(sitesList[0].name, 'my-docs');

  // 6. keys rotate
  const rotRes = await execCli(['keys', 'rotate', 'https://example.github.io/docs/mcp.html'], env);
  assert.equal(rotRes.code, 0);
  assert.equal(JSON.parse(rotRes.stdout).rotated.length, 1);

  // 7. open dashboard (with AI_PROXY_NO_BROWSER=1)
  const openRes = await execCli(['open', 'dashboard', '--port', '8788'], env);
  assert.equal(openRes.code, 0);
  assert.equal(JSON.parse(openRes.stdout).ok, true);

  // 8. vendor <target_dir> + create mcp.html + run doctor --dir <site_dir>
  const sampleSiteDir = path.join(env.root, 'sample-site');
  const vendorTarget = path.join(sampleSiteDir, 'web');
  const vendorRes = await execCli(['vendor', vendorTarget], env);
  assert.equal(vendorRes.code, 0);
  const vendorData = JSON.parse(vendorRes.stdout);
  assert.ok(vendorData.files.includes('model-context.mjs'));
  assert.ok(fs.existsSync(path.join(vendorTarget, 'model-context.mjs')));

  fs.writeFileSync(
    path.join(sampleSiteDir, 'mcp.html'),
    `<!doctype html><script type="module">import { mountMcpPageUi } from './web/ui.mjs';</script>`
  );

  const doctorRes = await execCli(['doctor', '--dir', sampleSiteDir], env);
  assert.equal(doctorRes.code, 0);
  assert.equal(JSON.parse(doctorRes.stdout).ok, true);

  // 9. install --login (writes into temp HOME without touching real user LaunchAgents)
  const installRes = await execCli(['install', '--login', '--port', '8788'], env);
  assert.equal(installRes.code, 0);
  const installData = JSON.parse(installRes.stdout);
  assert.ok(installData.serviceFile.startsWith(env.homeDir));
  assert.ok(fs.existsSync(installData.serviceFile));

  // 10. remove my-docs (invokes fake claude mcp remove)
  const rmRes = await execCli(['remove', 'my-docs'], env);
  assert.equal(rmRes.code, 0);
  const claudeCallsAfterRm = fs
    .readFileSync(env.claudeLog, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(claudeCallsAfterRm.length, 2);
  assert.deepEqual(claudeCallsAfterRm[1], ['mcp', 'remove', 'my-docs']);

  // 11. mcp --url stdio bridge against ephemeral relay server
  const store = createStore({ configDir: env.configDir });
  store.allowPrefix('https://example.github.io/stdio-test/');
  const relay = createRelayServer({ store, port: 0 });
  const { port } = await relay.start();
  t.after(() => relay.stop());

  const stdioRes = await execCli(
    ['mcp', '--url', 'https://example.github.io/stdio-test/mcp.html', '--port', String(port)],
    env,
    {
      stdinText:
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) +
        '\n' +
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping', params: {} }) +
        '\n'
    }
  );
  assert.equal(stdioRes.code, 0);
  const lines = stdioRes.stdout
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].id, 1);
  assert.equal(lines[0].result.protocolVersion, '2025-11-25');
  assert.equal(lines[1].id, 2);

  // 12. skills list and skills install
  const skillsListRes = await execCli(['skills', 'list'], env);
  assert.equal(skillsListRes.code, 0);
  const skillsListData = JSON.parse(skillsListRes.stdout);
  assert.equal(skillsListData.ok, true);
  assert.equal(skillsListData.action, 'list');
  assert.ok(skillsListData.skills.some((s) => s.name === 'ai-proxy'));
  assert.ok(skillsListData.skills.some((s) => s.name === 'mcp-pages'));

  // Single skill filter
  const singleSkillRes = await execCli(['skills', 'ai-proxy'], env);
  assert.equal(singleSkillRes.code, 0);
  const singleSkillData = JSON.parse(singleSkillRes.stdout);
  assert.equal(singleSkillData.skills.length, 1);
  assert.equal(singleSkillData.skills[0].name, 'ai-proxy');

  // Install to custom dir
  const customSkillsDir = path.join(env.root, 'custom-skills');
  const installCustomRes = await execCli(['skills', 'install', '--dir', customSkillsDir], env);
  assert.equal(installCustomRes.code, 0);
  const installCustomData = JSON.parse(installCustomRes.stdout);
  assert.equal(installCustomData.ok, true);
  assert.equal(installCustomData.action, 'install');
  assert.ok(fs.existsSync(path.join(customSkillsDir, 'ai-proxy', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(customSkillsDir, 'mcp-pages', 'SKILL.md')));

  // Install single skill to claude target
  const installClaudeRes = await execCli(['skills', 'install', 'ai-proxy', '--target', 'claude'], env);
  assert.equal(installClaudeRes.code, 0);
  const claudeSkillDir = path.join(env.homeDir, '.claude', 'skills', 'ai-proxy');
  assert.ok(fs.existsSync(path.join(claudeSkillDir, 'SKILL.md')));

  // Install with --copy to antigravity target
  const installCopyRes = await execCli(['skills', 'install', '--copy', '--target', 'antigravity'], env);
  assert.equal(installCopyRes.code, 0);
  const geminiSkillDir = path.join(env.homeDir, '.gemini', 'skills', 'ai-proxy');
  assert.ok(fs.existsSync(path.join(geminiSkillDir, 'SKILL.md')));
  const stat = fs.lstatSync(geminiSkillDir);
  assert.equal(stat.isSymbolicLink(), false);
});

