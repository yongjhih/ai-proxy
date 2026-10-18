import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { runCli } from '../src/cli.mjs';
import { buildDockerWrapperPlan, runDockerWrapper } from '../src/docker.mjs';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

function runScript(binPath, args, env) {
  return new Promise((resolve, reject) => {
    execFile(binPath, args, { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
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

test('.devcontainer configuration files exist and configure host.docker.internal and port 8788', () => {
  const devcontainerJson = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, '.devcontainer', 'devcontainer.json'), 'utf8')
  );
  assert.ok(devcontainerJson.forwardPorts.includes(8788));
  assert.ok(devcontainerJson.runArgs.includes('--add-host=host.docker.internal:host-gateway'));
  assert.equal(devcontainerJson.containerEnv.AI_PROXY_HOST, 'host.docker.internal');
  assert.equal(devcontainerJson.containerEnv.AI_PROXY_PORT, '8788');
  assert.equal(devcontainerJson.containerEnv.AI_PROXY_URL, 'http://host.docker.internal:8788');
  assert.ok(fs.existsSync(path.join(ROOT_DIR, '.devcontainer', 'Dockerfile')));
  assert.ok(fs.existsSync(path.join(ROOT_DIR, '.devcontainer', 'post-create.sh')));
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'Dockerfile')));
});

test('ai-proxy devcontainer init creates/merges .devcontainer/devcontainer.json and up/exec wraps devcontainer CLI', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-devc-'));
  const fakeBinDir = path.join(tmpDir, 'bin');
  const devcLogPath = path.join(tmpDir, 'devcontainer.log');
  fs.mkdirSync(fakeBinDir, { recursive: true });

  const fakeDevcontainerBin = path.join(fakeBinDir, 'fake-devcontainer');
  fs.writeFileSync(
    fakeDevcontainerBin,
    `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(
      devcLogPath
    )}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
    { mode: 0o755 }
  );

  const projectDir = path.join(tmpDir, 'my-project');
  fs.mkdirSync(path.join(projectDir, '.devcontainer'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.devcontainer', 'devcontainer.json'),
    JSON.stringify({ name: 'Existing Project', forwardPorts: [3000] }, null, 2)
  );

  async function execCli(args) {
    let out = '';
    let err = '';
    const code = await runCli(args, {
      env: {
        ...process.env,
        AI_PROXY_HOME: path.join(tmpDir, 'config'),
        AI_PROXY_DEVCONTAINER_BIN: fakeDevcontainerBin
      },
      stdin: Readable.from([]),
      stdout: new Writable({
        write(c, _e, cb) {
          out += c.toString();
          cb();
        }
      }),
      stderr: new Writable({
        write(c, _e, cb) {
          err += c.toString();
          cb();
        }
      })
    });
    return { code, out, err };
  }

  try {
    const initRes = await execCli(['devcontainer', 'init', '--dir', projectDir, '--port', '8799']);
    assert.equal(initRes.code, 0, initRes.err);
    const parsedOut = JSON.parse(initRes.out);
    assert.equal(parsedOut.ok, true);

    const merged = JSON.parse(
      fs.readFileSync(path.join(projectDir, '.devcontainer', 'devcontainer.json'), 'utf8')
    );
    assert.equal(merged.name, 'Existing Project');
    assert.deepEqual(merged.forwardPorts, [3000, 8799]);
    assert.ok(merged.runArgs.includes('--add-host=host.docker.internal:host-gateway'));
    assert.equal(merged.containerEnv.AI_PROXY_URL, 'http://host.docker.internal:8799');

    const upRes = await execCli(['devcontainer', 'up', '--dir', projectDir, '--port', '8799']);
    assert.equal(upRes.code, 0);

    const execRes = await execCli([
      'devcontainer',
      'exec',
      '--dir',
      projectDir,
      '--port',
      '8799',
      'claude'
    ]);
    assert.equal(execRes.code, 0);

    const logLines = fs
      .readFileSync(devcLogPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(logLines.length, 2);
    assert.equal(logLines[0][0], 'up');
    assert.ok(logLines[0].includes('AI_PROXY_URL=http://host.docker.internal:8799'));
    assert.equal(logLines[1][0], 'exec');
    assert.equal(logLines[1][logLines[1].length - 1], 'claude');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('docker-wrapper CLI (bin/ai-proxy-docker.mjs, bin/ai-proxy-docker, ai-proxy docker) handles containerized ai-proxy and wrapped docker run', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-docker-test-'));
  const dockerLogPath = path.join(tmpDir, 'docker.log');
  const fakeDockerBin = path.join(tmpDir, 'fake-docker');

  // Fake docker binary: returns exit code 1 on `image inspect` the first time to trigger `docker build`, then logs all calls
  const inspectMarker = path.join(tmpDir, 'image-built');
  fs.writeFileSync(
    fakeDockerBin,
    `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(dockerLogPath)}, JSON.stringify(args) + '\\n');
if (args[0] === 'image' && args[1] === 'inspect') {
  if (!fs.existsSync(${JSON.stringify(inspectMarker)})) {
    process.exit(1);
  }
  process.exit(0);
}
if (args[0] === 'build') {
  fs.writeFileSync(${JSON.stringify(inspectMarker)}, '1');
  process.exit(0);
}
process.exit(0);
`,
    { mode: 0o755 }
  );

  try {
    // 1. Unit check buildDockerWrapperPlan for `serve`, `mcp`, and `run`
    const servePlan = buildDockerWrapperPlan(['serve', '--port', '9123'], {
      env: { AI_PROXY_HOME: path.join(tmpDir, 'cfg') },
      cwd: tmpDir
    });
    assert.equal(servePlan.mode, 'containerized-ai-proxy');
    assert.equal(servePlan.port, 9123);
    assert.ok(servePlan.dockerArgs.includes('127.0.0.1:9123:8788'));
    assert.ok(servePlan.dockerArgs.includes('--add-host=host.docker.internal:host-gateway'));

    const mcpPlan = buildDockerWrapperPlan(['mcp', '--url', 'https://example.github.io/docs/mcp.html'], {
      env: { AI_PROXY_HOME: path.join(tmpDir, 'cfg') },
      cwd: tmpDir
    });
    assert.equal(mcpPlan.mode, 'containerized-ai-proxy');
    assert.ok(mcpPlan.dockerArgs.includes('host.docker.internal'));

    const wrapRunPlan = buildDockerWrapperPlan(['run', '-it', 'my-agent:latest', 'claude'], {
      env: { AI_PROXY_HOME: path.join(tmpDir, 'cfg'), AI_PROXY_PORT: '8788' },
      cwd: tmpDir
    });
    assert.equal(wrapRunPlan.mode, 'wrap-docker-run');
    assert.ok(wrapRunPlan.dockerArgs.includes('--add-host=host.docker.internal:host-gateway'));
    assert.ok(wrapRunPlan.dockerArgs.includes('AI_PROXY_HOST=host.docker.internal'));
    assert.ok(wrapRunPlan.dockerArgs.includes('AI_PROXY_URL=http://host.docker.internal:8788'));
    assert.equal(wrapRunPlan.dockerArgs[wrapRunPlan.dockerArgs.length - 1], 'claude');

    // 2. Execute via `ai-proxy docker-wrapper` and `bin/ai-proxy-docker.mjs` using fake docker binary
    let stdoutStr = '';
    let stderrStr = '';
    const exitCode = await runDockerWrapper(['serve', '--port', '8899'], {
      env: {
        ...process.env,
        AI_PROXY_DOCKER_BIN: fakeDockerBin,
        AI_PROXY_HOME: path.join(tmpDir, 'cfg')
      },
      cwd: tmpDir,
      stdout: new Writable({
        write(c, _e, cb) {
          stdoutStr += c.toString();
          cb();
        }
      }),
      stderr: new Writable({
        write(c, _e, cb) {
          stderrStr += c.toString();
          cb();
        }
      })
    });
    assert.equal(exitCode, 0);

    // Execute `bin/ai-proxy-docker` shell script for `run` mode
    await runScript(
      path.join(ROOT_DIR, 'bin', 'ai-proxy-docker'),
      ['run', 'ubuntu:24.04', 'echo', 'hello'],
      {
        AI_PROXY_DOCKER_BIN: fakeDockerBin,
        AI_PROXY_HOME: path.join(tmpDir, 'cfg'),
        AI_PROXY_PORT: '8899'
      }
    );

    const calls = fs
      .readFileSync(dockerLogPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    // Call 1: image inspect -> failed -> Call 2: build -> Call 3: run serve -> Call 4: run ubuntu:24.04
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[0].slice(0, 2), ['image', 'inspect']);
    assert.equal(calls[1][0], 'build');
    assert.equal(calls[2][0], 'run');
    assert.ok(calls[2].includes('127.0.0.1:8899:8788'));
    assert.equal(calls[3][0], 'run');
    assert.ok(calls[3].includes('AI_PROXY_URL=http://host.docker.internal:8899'));

    // 3. Verify `ai-proxy add` inside a container with AI_PROXY_HOST=host.docker.internal registers host.docker.internal URL
    const claudeLog = path.join(tmpDir, 'claude.log');
    const fakeClaude = path.join(tmpDir, 'fake-claude');
    fs.writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(
        claudeLog
      )}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
      { mode: 0o755 }
    );

    let addOut = '';
    const addCode = await runCli(
      ['add', 'https://example.github.io/docs/mcp.html', '--name', 'docs'],
      {
        env: {
          ...process.env,
          AI_PROXY_HOME: path.join(tmpDir, 'cfg'),
          AI_PROXY_HOST: 'host.docker.internal',
          AI_PROXY_PORT: '8788',
          AI_PROXY_CLAUDE_BIN: fakeClaude
        },
        stdin: Readable.from([]),
        stdout: new Writable({
          write(c, _e, cb) {
            addOut += c.toString();
            cb();
          }
        }),
        stderr: new Writable({
          write(_c, _e, cb) {
            cb();
          }
        })
      }
    );
    assert.equal(addCode, 0);
    const parsedAdd = JSON.parse(addOut);
    assert.equal(
      parsedAdd.mcpEndpoint,
      'http://host.docker.internal:8788/mcp?url=https%3A%2F%2Fexample.github.io%2Fdocs%2Fmcp.html'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
