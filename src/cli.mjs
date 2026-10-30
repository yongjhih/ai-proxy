import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore, validateAllowToolSpec, getEquivalentPageUrls } from './store.mjs';
import { createRelayServer, defaultOpenBrowser } from './relay.mjs';
import { runDockerWrapper, runDevcontainerSubcommand } from './docker.mjs';
import { createLlmBackend } from './llm.mjs';
import { normalizePageUrl, resolveMcpEndpoint } from '../web/url.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WEB_MODULES_DIR = path.join(REPO_ROOT, 'web');

function runCommand(bin, args, env) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseFlags(args) {
  const positionals = [];
  const flags = {
    allowTools: []
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--port' || arg === '-p') {
      flags.port = Number.parseInt(args[++i] || '', 10);
    } else if (arg === '--host') {
      flags.host = args[++i];
    } else if (arg === '--url') {
      flags.url = args[++i];
    } else if (arg === '--name') {
      flags.name = args[++i];
    } else if (arg === '--ttl') {
      flags.ttl = Number.parseFloat(args[++i] || '');
    } else if (arg === '--dir') {
      flags.dir = args[++i];
    } else if (arg === '--target') {
      flags.target = args[++i];
    } else if (arg === '--copy') {
      flags.copy = true;
    } else if (arg === '--out' || arg === '-o') {
      flags.out = args[++i];
    } else if (arg === '--allow-tool') {
      flags.allowTools.push(args[++i]);
    } else if (arg === '--origin') {
      flags.origin = true;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--all') {
      flags.all = true;
    } else if (arg === '--admin') {
      flags.admin = true;
    } else if (arg === '--login') {
      flags.login = true;
    } else if (arg === '--read-only' || arg === '--readonly') {
      flags.readOnly = true;
    } else if (arg === '--write') {
      flags.write = true;
    } else if (arg === '--no-origin') {
      flags.noOrigin = true;
    } else if (arg === '--no-prefix') {
      flags.noPrefix = true;
    } else if (arg === '--upstream' || arg === '--upstream-url') {
      flags.upstream = args[++i];
    } else if (arg === '--cli') {
      flags.cli = args[++i];
    } else if (arg === '--model' || arg === '-m') {
      flags.model = args[++i];
    } else if (arg === '--gemini-key') {
      flags.geminiKey = args[++i];
    } else if (arg === '--anthropic-key') {
      flags.anthropicKey = args[++i];
    } else if (arg === '--openai-key') {
      flags.openaiKey = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}

function printWarningsToStderr(store, stderr) {
  for (const w of store.getWarnings()) {
    stderr.write(`${w}\n`);
  }
}

export async function registerSiteInClaude(site, port, env = process.env, host = '127.0.0.1') {
  const claudeBin = env.AI_PROXY_CLAUDE_BIN || 'claude';
  const effectiveHost = env.AI_PROXY_HOST || host || '127.0.0.1';
  const endpoint = `http://${effectiveHost}:${port}/mcp?url=${encodeURIComponent(site.url)}`;
  await runCommand(claudeBin, ['mcp', 'add', '--transport', 'http', site.name, endpoint], env);
  return endpoint;
}

export async function removeSiteFromClaude(name, env = process.env) {
  const claudeBin = env.AI_PROXY_CLAUDE_BIN || 'claude';
  await runCommand(claudeBin, ['mcp', 'remove', name], env);
}

export function loadAvailableSkills(skillsRoot = path.join(REPO_ROOT, 'skills')) {
  if (!fs.existsSync(skillsRoot)) return [];
  const entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  const list = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const skillDir = path.join(skillsRoot, ent.name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const content = fs.readFileSync(skillFile, 'utf8');
    let name = ent.name;
    let description = '';
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (match) {
      const nameMatch = match[1].match(/^name:\s*(.+)$/m);
      if (nameMatch) name = nameMatch[1].trim();
      const descMatch = match[1].match(/^description:\s*(.+)$/m);
      if (descMatch) description = descMatch[1].trim();
    }
    list.push({
      name,
      description,
      dir: skillDir,
      skillFile
    });
  }
  return list;
}

export function resolveSkillTargetDirs({ target = 'all', customDir, home = os.homedir(), cwd = process.cwd() } = {}) {
  if (customDir) {
    return [path.resolve(cwd, customDir)];
  }
  const t = String(target || 'all').toLowerCase();
  switch (t) {
    case 'claude':
    case 'claudecode':
    case 'claude-code':
      return [path.join(home, '.claude', 'skills')];
    case 'antigravity':
    case 'agy':
    case 'gemini':
      return [path.join(home, '.gemini', 'skills')];
    case 'agents':
    case 'codex':
      return [path.join(home, '.agents', 'skills')];
    case 'cursor':
      return [path.join(cwd, '.cursor', 'skills')];
    case 'windsurf':
      return [path.join(cwd, '.windsurf', 'skills')];
    case 'all':
    default:
      return [
        path.join(home, '.claude', 'skills'),
        path.join(home, '.gemini', 'skills'),
        path.join(home, '.agents', 'skills')
      ];
  }
}

export function installSkillToDir(skill, targetDir, { preferCopy = false } = {}) {
  fs.mkdirSync(targetDir, { recursive: true });
  const dest = path.join(targetDir, skill.name);
  if (fs.existsSync(dest)) {
    try {
      const stat = fs.lstatSync(dest);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(dest);
      } else {
        fs.rmSync(dest, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }

  let method = preferCopy ? 'copy' : 'symlink';
  if (!preferCopy) {
    try {
      const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
      fs.symlinkSync(skill.dir, dest, symlinkType);
    } catch {
      method = 'copy';
      fs.cpSync(skill.dir, dest, { recursive: true });
    }
  } else {
    fs.cpSync(skill.dir, dest, { recursive: true });
  }

  return {
    skill: skill.name,
    targetDir,
    dest,
    method
  };
}

export async function runCli(
  argv = process.argv.slice(2),
  {
    env = process.env,
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr
  } = {}
) {
  const firstArg = argv[0];
  if (firstArg === 'docker' || firstArg === 'docker-wrapper') {
    return runDockerWrapper(argv.slice(1), { env, stdout, stderr });
  }
  if (firstArg === 'devcontainer') {
    return runDevcontainerSubcommand(argv.slice(1), { env, stdout, stderr });
  }

  const { positionals, flags } = parseFlags(argv);
  const subcommand = positionals[0];

  if (!subcommand || flags.help || subcommand === 'help') {
    stderr.write(
      `Usage: ai-proxy <command> [options]

Commands:
  serve [--port 8788] [--allow-tool mcp__<server>__<tool>] [--upstream <url>] [--cli <agy|claude>] [--model <name>]
  mcp --url <page_url> [--port 8788]
  add <page_url> [--name <slug>] [--read-only] [--no-origin] [--no-prefix] [--port 8788]
  remove <page_url_or_name>
  allow <url_prefix>
  allow-origin <origin|*> [--ttl <seconds>]
  deny <url_prefix_or_origin> [--origin]
  sites [--json]
  doctor [--dir <site_dir>]
  open [dashboard|<page_url>] [--port 8788]
  keys rotate [<page_url>|--all|--admin]
  vendor <target_dir>
  install --login [--port 8788]
  skills [install|list] [<skill_name>] [--target <claude|antigravity|agents|cursor|all>] [--dir <dir>] [--copy]
  docker <subcommand|run> [args...]
  docker-wrapper <subcommand|run> [args...]
  devcontainer [init|up|exec] [--dir <dir>] [--port 8788]
`
    );
    return subcommand === 'help' || flags.help ? 0 : 2;
  }

  const configDir =
    env.AI_PROXY_HOME || path.join(env.HOME || os.homedir(), '.config', 'ai-proxy');
  const store = createStore({ configDir });
  const envPort = Number.parseInt(env.AI_PROXY_PORT || '', 10);
  const port =
    Number.isInteger(flags.port) && flags.port >= 0
      ? flags.port
      : Number.isInteger(envPort) && envPort > 0
        ? envPort
        : 8788;
  const host = flags.host || env.AI_PROXY_HOST || '127.0.0.1';
  const openBrowser =
    env.AI_PROXY_NO_BROWSER === '1' ? async () => true : defaultOpenBrowser;

  try {
    if (subcommand === 'serve') {
      if (flags.allowTools.length > 0) {
        try {
          store.setAllowedTools(flags.allowTools);
        } catch (err) {
          stderr.write(`Error: ${err.message}\n`);
          return 2;
        }
      }

      const chatBackend = createLlmBackend({
        upstreamUrl: flags.upstream,
        geminiKey: flags.geminiKey,
        anthropicKey: flags.anthropicKey,
        openaiKey: flags.openaiKey,
        cliName: flags.cli,
        defaultModel: flags.model,
        env
      });

      const relay = createRelayServer({
        store,
        host,
        port,
        openBrowser,
        chatBackend: chatBackend || undefined,
        onSiteAdded: (site, p) => registerSiteInClaude(site, p, env),
        onSiteRemoved: (site) => removeSiteFromClaude(site.name, env)
      });
      const bound = await relay.start();
      printWarningsToStderr(store, stderr);
      if (chatBackend) {
        stderr.write(`LLM upstream active: ${chatBackend.provider} (model: ${chatBackend.model})\n`);
      }
      stderr.write(`ai-proxy listening on http://${bound.host}:${bound.port}\n`);
      stdout.write(`${JSON.stringify({ ok: true, host: bound.host, port: bound.port })}\n`);
      return 0;
    }

    if (subcommand === 'mcp') {
      const targetUrl = flags.url || positionals[1];
      if (!targetUrl) {
        stderr.write('Error: mcp requires --url <page_url>\n');
        return 2;
      }
      const normalized = normalizePageUrl(targetUrl);
      const endpoint = `http://${host}:${port}/mcp?url=${encodeURIComponent(normalized)}`;

      const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: trimmed
        });
        if (res.status === 202) continue;
        const text = await res.text();
        if (text.trim()) {
          stdout.write(`${text.trim()}\n`);
        }
      }
      return 0;
    }

    if (subcommand === 'allow') {
      const prefix = positionals[1];
      if (!prefix) {
        stderr.write('Error: allow requires <url_prefix>\n');
        return 2;
      }
      const normalized = normalizePageUrl(prefix);
      const allowlist = store.allowPrefix(normalized);
      stderr.write(`Allowed URL prefix: ${normalized}\n`);
      stdout.write(`${JSON.stringify({ ok: true, prefix: normalized, allowlist })}\n`);
      return 0;
    }

    if (subcommand === 'allow-origin') {
      const originArg = positionals[1];
      if (!originArg) {
        stderr.write('Error: allow-origin requires <origin|*>\n');
        return 2;
      }
      const res = store.allowOrigin(originArg, { ttlSeconds: flags.ttl });
      printWarningsToStderr(store, stderr);
      stderr.write(`Allowed /v1 origin: ${originArg}\n`);
      stdout.write(`${JSON.stringify({ ok: true, origin: originArg, ...res })}\n`);
      return 0;
    }

    if (subcommand === 'deny') {
      const target = positionals[1];
      if (!target) {
        stderr.write('Error: deny requires <url_prefix_or_origin>\n');
        return 2;
      }
      if (flags.origin || target === '*') {
        const res = store.denyOrigin(target);
        stderr.write(`Revoked /v1 origin: ${target}\n`);
        stdout.write(`${JSON.stringify({ ok: true, revokedOrigin: target, ...res })}\n`);
        return 0;
      }
      const normalized = normalizePageUrl(target);
      const allowlist = store.denyPrefix(normalized);
      stderr.write(`Denied URL prefix: ${normalized}\n`);
      stdout.write(`${JSON.stringify({ ok: true, deniedPrefix: normalized, allowlist })}\n`);
      return 0;
    }

    if (subcommand === 'add') {
      const urlArg = positionals[1];
      if (!urlArg) {
        stderr.write('Error: add requires <page_url>\n');
        return 2;
      }
      let targetUrl = urlArg;
      try {
        targetUrl = await resolveMcpEndpoint(urlArg);
      } catch {}
      const site = store.addSite({
        url: targetUrl,
        name: flags.name,
        write: !flags.readOnly,
        allowOrigin: !flags.noOrigin,
        allowPrefix: !flags.noPrefix
      });
      let mcpEndpoint = `http://${host}:${port}/mcp?url=${encodeURIComponent(site.url)}`;
      try {
        mcpEndpoint = await registerSiteInClaude(site, port, env, host);
      } catch (err) {
        stderr.write(`Warning: claude mcp add failed (${err.message}); site still saved locally.\n`);
      }
      stderr.write(
        `Added site "${site.name}" -> ${site.url} (${site.write ? 'read/write' : 'read-only'})\n`
      );
      stdout.write(
        `${JSON.stringify({
          ok: true,
          name: site.name,
          url: site.url,
          write: site.write,
          mcpEndpoint
        })}\n`
      );
      return 0;
    }

    if (subcommand === 'remove') {
      const target = positionals[1];
      if (!target) {
        stderr.write('Error: remove requires <page_url_or_name>\n');
        return 2;
      }
      const allSites = store.listSites();
      const matched = allSites.find((s) => {
        if (s.name === target) return true;
        try {
          return getEquivalentPageUrls(target).includes(s.url);
        } catch {
          return false;
        }
      });

      const urlToRemove = matched ? matched.url : normalizePageUrl(target);
      const nameToRemove = matched ? matched.name : target;

      store.removeSite(urlToRemove);
      try {
        await removeSiteFromClaude(nameToRemove, env);
      } catch (err) {
        stderr.write(`Warning: claude mcp remove failed (${err.message}).\n`);
      }

      stderr.write(`Removed site "${nameToRemove}" (${urlToRemove})\n`);
      stdout.write(
        `${JSON.stringify({
          ok: true,
          name: nameToRemove,
          removed: urlToRemove
        })}\n`
      );
      return 0;
    }

    if (subcommand === 'sites') {
      printWarningsToStderr(store, stderr);
      const sites = store.listSites().map((s) => ({
        name: s.name,
        url: s.url,
        toolCount: Array.isArray(s.tools) ? s.tools.length : 0,
        lastSeenAt: s.lastSeenAt
      }));
      stderr.write(`${sites.length} registered site(s)\n`);
      stdout.write(`${JSON.stringify(sites, null, 2)}\n`);
      return 0;
    }

    if (subcommand === 'keys') {
      const action = positionals[1];
      if (action !== 'rotate') {
        stderr.write('Error: expected "keys rotate [<url>|--all|--admin]"\n');
        return 2;
      }
      const targetUrl = positionals[2];
      const rotated = store.rotateKeys({
        url: targetUrl,
        rotateAdmin: Boolean(flags.admin)
      });
      stderr.write(`Rotated ${rotated.length} key(s)\n`);
      stdout.write(`${JSON.stringify({ ok: true, rotated })}\n`);
      return 0;
    }

    if (subcommand === 'open') {
      const target = positionals[1] || 'dashboard';
      if (target === 'dashboard') {
        const dashUrl = `http://${host}:${port}/dashboard.html#admin-key=${encodeURIComponent(
          store.getAdminKey()
        )}&mcp-port=${port}`;
        await openBrowser(dashUrl);
        stderr.write(`Opened dashboard on port ${port}\n`);
        stdout.write(`${JSON.stringify({ ok: true, target: 'dashboard', port })}\n`);
        return 0;
      }
      const normalized = normalizePageUrl(target);
      store.allowPrefix(normalized);
      const pageKey = store.getOrCreatePageKey(normalized);
      const launchUrl = `${normalized}#mcp-key=${encodeURIComponent(pageKey)}&mcp-port=${port}`;
      await openBrowser(launchUrl);
      stderr.write(`Opened MCP page: ${normalized}\n`);
      stdout.write(`${JSON.stringify({ ok: true, target: normalized, port })}\n`);
      return 0;
    }

    if (subcommand === 'vendor') {
      const targetDir = flags.out || positionals[1];
      if (!targetDir) {
        stderr.write('Error: vendor requires <target_dir> or --out <target_dir>\n');
        return 2;
      }
      const resolvedTarget = path.resolve(targetDir);
      fs.mkdirSync(resolvedTarget, { recursive: true });
      const files = fs
        .readdirSync(WEB_MODULES_DIR)
        .filter((f) => f.endsWith('.mjs'))
        .sort();
      for (const file of files) {
        fs.copyFileSync(path.join(WEB_MODULES_DIR, file), path.join(resolvedTarget, file));
      }
      stderr.write(`Vendored ${files.length} WebMCP module(s) into ${resolvedTarget}\n`);
      stdout.write(`${JSON.stringify({ ok: true, targetDir: resolvedTarget, files })}\n`);
      return 0;
    }

    if (subcommand === 'doctor') {
      printWarningsToStderr(store, stderr);
      const siteDir = path.resolve(flags.dir || process.cwd());
      const checks = [];

      // Check 1: mcp.html exists
      const mcpHtmlPath = path.join(siteDir, 'mcp.html');
      const hasMcpHtml = fs.existsSync(mcpHtmlPath);
      checks.push({
        name: 'mcp_page_exists',
        ok: hasMcpHtml,
        detail: hasMcpHtml ? mcpHtmlPath : `Missing mcp.html in ${siteDir}`
      });

      // Check 2: web/*.mjs modules exist in siteDir/web/ or siteDir/vendor/ai-proxy-web/
      const requiredModules = [
        'url.mjs',
        'handshake.mjs',
        'model-context.mjs',
        'dispatch.mjs',
        'client.mjs',
        'ui.mjs'
      ];
      const candidateDirs = [
        path.join(siteDir, 'web'),
        path.join(siteDir, 'vendor', 'ai-proxy-web')
      ];
      const activeModDir =
        candidateDirs.find((d) => fs.existsSync(d)) || path.join(siteDir, 'web');
      const missingModules = requiredModules.filter(
        (m) => !fs.existsSync(path.join(activeModDir, m))
      );
      checks.push({
        name: 'vendored_web_modules',
        ok: missingModules.length === 0,
        detail:
          missingModules.length === 0
            ? `All required WebMCP modules present in ${path.relative(siteDir, activeModDir) || 'web'}`
            : `Missing modules in ${path.relative(siteDir, activeModDir) || 'web'}: ${missingModules.join(', ')}`
      });

      // Check 3: mcp.html imports WebMCP module and does not use localStorage for mcp-key
      if (hasMcpHtml) {
        const htmlContent = fs.readFileSync(mcpHtmlPath, 'utf8');
        const usesWebModule = /(?:web|ai-proxy-web)\/(ui|index|client|model-context)\.mjs/.test(
          htmlContent
        );
        const leaksStorage = /localStorage\.setItem\([^)]*mcp-key/i.test(htmlContent);
        checks.push({
          name: 'mcp_page_wiring',
          ok: usesWebModule && !leaksStorage,
          detail:
            usesWebModule && !leaksStorage
              ? 'mcp.html properly imports WebMCP modules without storage leaks'
              : 'mcp.html must import ./web/*.mjs (or ./vendor/ai-proxy-web/*.mjs) and never store mcp-key in localStorage'
        });
      }

      const allOk = checks.every((c) => c.ok);
      const report = {
        ok: allOk,
        siteDir,
        checks,
        warnings: store.getWarnings()
      };
      stderr.write(`Doctor check ${allOk ? 'PASSED' : 'FAILED'} for ${siteDir}\n`);
      stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return allOk ? 0 : 1;
    }

    if (subcommand === 'install') {
      if (!flags.login) {
        stderr.write('Error: expected "install --login"\n');
        return 2;
      }
      const home = env.HOME || os.homedir();
      const binScript = path.resolve(REPO_ROOT, 'bin', 'ai-proxy.mjs');
      let serviceFile;
      if (process.platform === 'darwin') {
        const agentsDir = path.join(home, 'Library', 'LaunchAgents');
        fs.mkdirSync(agentsDir, { recursive: true });
        serviceFile = path.join(agentsDir, 'io.github.ai-proxy.plist');
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.github.ai-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${binScript}</string>
    <string>serve</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
        fs.writeFileSync(serviceFile, plist, 'utf8');
      } else {
        const systemdDir = path.join(home, '.config', 'systemd', 'user');
        fs.mkdirSync(systemdDir, { recursive: true });
        serviceFile = path.join(systemdDir, 'ai-proxy.service');
        const unit = `[Unit]
Description=ai-proxy local MCP Pages relay
After=network.target

[Service]
ExecStart=${process.execPath} ${binScript} serve --port ${port}
Restart=on-failure

[Install]
WantedBy=default.target
`;
        fs.writeFileSync(serviceFile, unit, 'utf8');
      }

      stderr.write(`Installed login service at ${serviceFile}\n`);
      stdout.write(
        `${JSON.stringify({
          ok: true,
          platform: process.platform,
          serviceFile,
          port
        })}\n`
      );
      return 0;
    }

    if (subcommand === 'skills') {
      const availableSkills = loadAvailableSkills();
      if (availableSkills.length === 0) {
        stderr.write('Error: no skills found in skills/ directory\n');
        return 1;
      }

      let action = 'list';
      let skillNameFilter = null;

      const pos1 = positionals[1];
      const pos2 = positionals[2];

      if (pos1 === 'install') {
        action = 'install';
        skillNameFilter = pos2 || null;
      } else if (pos1 === 'list') {
        action = 'list';
        skillNameFilter = pos2 || null;
      } else if (pos1) {
        if (availableSkills.some((s) => s.name === pos1)) {
          action = 'list';
          skillNameFilter = pos1;
        } else {
          stderr.write(
            `Unknown skills action: ${pos1}\nUsage: ai-proxy skills [install|list] [<skill_name>] [--target <claude|antigravity|agents|cursor|all>] [--dir <dir>] [--copy]\n`
          );
          return 2;
        }
      }

      const selectedSkills = skillNameFilter
        ? availableSkills.filter((s) => s.name === skillNameFilter)
        : availableSkills;

      if (selectedSkills.length === 0) {
        stderr.write(
          `Error: skill "${skillNameFilter}" not found. Available: ${availableSkills.map((s) => s.name).join(', ')}\n`
        );
        return 1;
      }

      if (action === 'list') {
        stderr.write(`Available ai-proxy skills (${selectedSkills.length}):\n`);
        for (const s of selectedSkills) {
          stderr.write(`  - ${s.name}: ${s.description}\n`);
        }
        stdout.write(
          `${JSON.stringify(
            {
              ok: true,
              action: 'list',
              skills: selectedSkills
            },
            null,
            2
          )}\n`
        );
        return 0;
      }

      if (action === 'install') {
        const home = env.HOME || os.homedir();
        const targetDirs = resolveSkillTargetDirs({
          target: flags.target,
          customDir: flags.dir,
          home,
          cwd: process.cwd()
        });

        const installed = [];
        for (const targetDir of targetDirs) {
          for (const s of selectedSkills) {
            const res = installSkillToDir(s, targetDir, { preferCopy: flags.copy });
            installed.push(res);
            stderr.write(`Installed skill ${s.name} -> ${res.dest} (${res.method})\n`);
          }
        }

        stdout.write(
          `${JSON.stringify(
            {
              ok: true,
              action: 'install',
              target: flags.target || (flags.dir ? 'custom' : 'all'),
              installed
            },
            null,
            2
          )}\n`
        );
        return 0;
      }
    }

    stderr.write(`Unknown command: ${subcommand}\n`);
    return 2;
  } catch (err) {
    stderr.write(`Error: ${err && err.message ? err.message : String(err)}\n`);
    return 1;
  }
}
