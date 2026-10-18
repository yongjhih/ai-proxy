import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function execSpawn(bin, args, { env = process.env, stdio = 'inherit', stdout, stderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...env },
      stdio: stdout || stderr ? ['ignore', 'pipe', 'pipe'] : stdio
    });
    if (stdout && child.stdout) {
      child.stdout.on('data', (chunk) => stdout.write(chunk));
    }
    if (stderr && child.stderr) {
      child.stderr.on('data', (chunk) => stderr.write(chunk));
    }
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 0));
  });
}

/**
 * Build the `docker` CLI argument list for either:
 * 1. Wrapping `docker run <user_args...>` with ai-proxy host bridge env/mounts, or
 * 2. Running an `ai-proxy` subcommand (`serve`, `add`, `mcp`, `doctor`, etc.) inside the ai-proxy container.
 */
export function buildDockerWrapperPlan(
  argv = [],
  {
    env = process.env,
    cwd = process.cwd(),
    repoRoot = REPO_ROOT
  } = {}
) {
  const imageName = env.AI_PROXY_DOCKER_IMAGE || 'ai-proxy:local';
  const defaultPort = Number.parseInt(env.AI_PROXY_PORT || '8788', 10) || 8788;
  const homeDir = env.HOME || os.homedir();
  const configDir = path.resolve(
    env.AI_PROXY_HOME || path.join(homeDir, '.config', 'ai-proxy')
  );

  // Strip optional leading flags meant for the wrapper itself
  const rest = [...argv];
  let dryRun = false;
  let forceBuild = false;
  let customPort = null;

  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--dry-run') {
      dryRun = true;
      rest.splice(i, 1);
      i -= 1;
    } else if (rest[i] === '--build') {
      forceBuild = true;
      rest.splice(i, 1);
      i -= 1;
    } else if ((rest[i] === '--port' || rest[i] === '-p') && rest[i + 1]) {
      const parsed = Number.parseInt(rest[i + 1], 10);
      if (Number.isInteger(parsed) && parsed >= 0) {
        customPort = parsed;
      }
    }
  }

  const port = customPort !== null ? customPort : defaultPort;
  const first = rest[0] || 'serve';

  // Mode 1: Wrapping `docker run ...` so a container (e.g. Claude Code container) can reach host ai-proxy
  if (first === 'run') {
    const userRunArgs = rest.slice(1);
    const runArgs = [
      'run',
      '--add-host=host.docker.internal:host-gateway',
      '-e',
      'AI_PROXY_HOST=host.docker.internal',
      '-e',
      `AI_PROXY_PORT=${port}`,
      '-e',
      `AI_PROXY_URL=http://host.docker.internal:${port}`,
      '-v',
      `${configDir}:/root/.config/ai-proxy`,
      ...userRunArgs
    ];
    return {
      mode: 'wrap-docker-run',
      dryRun,
      forceBuild: false,
      imageName,
      port,
      configDir,
      repoRoot,
      dockerArgs: runArgs
    };
  }

  // Mode 2: Running ai-proxy itself inside Docker (`serve`, `mcp`, `add`, `sites`, `doctor`, `vendor`, etc.)
  const subcommand = first;
  const dockerArgs = [
    'run',
    '--rm',
    '-i',
    '--add-host=host.docker.internal:host-gateway',
    '-e',
    'AI_PROXY_HOME=/data/ai-proxy',
    '-v',
    `${configDir}:/data/ai-proxy`,
    '-v',
    `${path.resolve(cwd)}:/workspace`,
    '-w',
    '/workspace'
  ];

  let containerCmdArgs = [...rest];
  if (containerCmdArgs.length === 0) {
    containerCmdArgs = ['serve'];
  }

  if (subcommand === 'serve') {
    dockerArgs.push('-p', `127.0.0.1:${port}:8788`);
    if (!containerCmdArgs.includes('--host')) {
      containerCmdArgs.push('--host', '0.0.0.0');
    }
    if (!containerCmdArgs.includes('--port') && !containerCmdArgs.includes('-p')) {
      containerCmdArgs.push('--port', '8788');
    }
  } else if (subcommand === 'mcp') {
    if (!containerCmdArgs.includes('--host')) {
      containerCmdArgs.push('--host', 'host.docker.internal');
    }
  }

  dockerArgs.push(imageName, ...containerCmdArgs);

  return {
    mode: 'containerized-ai-proxy',
    subcommand,
    dryRun,
    forceBuild,
    imageName,
    port,
    configDir,
    repoRoot,
    dockerArgs
  };
}

export async function runDockerWrapper(
  argv = [],
  {
    env = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr
  } = {}
) {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    stderr.write(
      `Usage: ai-proxy-docker [options] <command> [args...]
       ai-proxy docker [options] <command> [args...]

Modes:
  1. Run ai-proxy inside Docker (zero host Node setup required):
     ai-proxy-docker serve [--port 8788]
     ai-proxy-docker add https://example.github.io/docs/mcp.html --name docs
     ai-proxy-docker mcp --url https://example.github.io/docs/mcp.html
     ai-proxy-docker doctor --dir .

  2. Wrap "docker run" so containerized AI tools (e.g. Claude Code) connect to host ai-proxy:
     ai-proxy-docker run [docker_run_flags] <image> [command...]

Options:
  --port, -p <port>   Host ai-proxy port (default: 8788 or $AI_PROXY_PORT)
  --build             Force rebuild of the ai-proxy Docker image
  --dry-run           Print the resolved docker command JSON to stdout without executing
`
    );
    return 0;
  }

  const dockerBin = env.AI_PROXY_DOCKER_BIN || 'docker';
  const plan = buildDockerWrapperPlan(argv, { env, cwd });

  fs.mkdirSync(plan.configDir, { recursive: true });

  if (plan.dryRun) {
    stdout.write(
      `${JSON.stringify({
        ok: true,
        mode: plan.mode,
        dockerBin,
        imageName: plan.imageName,
        port: plan.port,
        configDir: plan.configDir,
        dockerArgs: plan.dockerArgs
      })}\n`
    );
    return 0;
  }

  if (plan.mode === 'containerized-ai-proxy') {
    let needsBuild = plan.forceBuild;
    if (!needsBuild) {
      const inspectCode = await execSpawn(
        dockerBin,
        ['image', 'inspect', plan.imageName],
        { env, stdio: 'ignore' }
      );
      if (inspectCode !== 0) {
        needsBuild = true;
      }
    }
    if (needsBuild) {
      stderr.write(`Building Docker image ${plan.imageName} from ${plan.repoRoot}...\n`);
      const buildCode = await execSpawn(
        dockerBin,
        ['build', '-t', plan.imageName, plan.repoRoot],
        { env, stdout: stderr, stderr }
      );
      if (buildCode !== 0) {
        stderr.write(`Error: docker build failed with exit code ${buildCode}\n`);
        return buildCode;
      }
    }
  }

  return execSpawn(dockerBin, plan.dockerArgs, { env, stdout, stderr });
}

/**
 * Generate or update `.devcontainer/devcontainer.json` in `targetDir` so tools inside
 * the devcontainer can reach the host `ai-proxy` relay (or run `ai-proxy` inside the container).
 */
export function initDevcontainerConfig(
  targetDir = process.cwd(),
  { port = 8788, name = 'MCP Pages & ai-proxy Dev Container' } = {}
) {
  const resolvedDir = path.resolve(targetDir);
  const devcontainerDir = path.join(resolvedDir, '.devcontainer');
  const devcontainerJsonPath = path.join(devcontainerDir, 'devcontainer.json');

  fs.mkdirSync(devcontainerDir, { recursive: true });

  let existing = {};
  if (fs.existsSync(devcontainerJsonPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(devcontainerJsonPath, 'utf8'));
    } catch {
      existing = {};
    }
  }

  const forwardPorts = Array.isArray(existing.forwardPorts) ? [...existing.forwardPorts] : [];
  if (!forwardPorts.includes(port)) {
    forwardPorts.push(port);
  }

  const runArgs = Array.isArray(existing.runArgs) ? [...existing.runArgs] : [];
  if (!runArgs.some((a) => a.startsWith('--add-host=host.docker.internal:'))) {
    runArgs.push('--add-host=host.docker.internal:host-gateway');
  }

  const mounts = Array.isArray(existing.mounts) ? [...existing.mounts] : [];
  const configMount =
    'source=${localEnv:HOME}/.config/ai-proxy,target=/home/node/.config/ai-proxy,type=bind,consistency=cached';
  if (!mounts.some((m) => String(m).includes('.config/ai-proxy'))) {
    mounts.push(configMount);
  }

  const nextConfig = {
    name: existing.name || name,
    ...(existing.image || existing.build || existing.dockerComposeFile
      ? {}
      : { image: 'mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm' }),
    ...existing,
    forwardPorts,
    portsAttributes: {
      ...(existing.portsAttributes || {}),
      [String(port)]: {
        label: 'ai-proxy Local Relay',
        onAutoForward: 'notify'
      }
    },
    runArgs,
    containerEnv: {
      ...(existing.containerEnv || {}),
      AI_PROXY_HOST: 'host.docker.internal',
      AI_PROXY_PORT: String(port),
      AI_PROXY_URL: `http://host.docker.internal:${port}`,
      AI_PROXY_HOME: '/home/node/.config/ai-proxy'
    },
    mounts
  };

  fs.writeFileSync(devcontainerJsonPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
  return {
    devcontainerJsonPath,
    config: nextConfig
  };
}

export async function runDevcontainerSubcommand(
  argv = [],
  {
    env = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr
  } = {}
) {
  const action = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'init';
  let targetDir = cwd;
  let port = Number.parseInt(env.AI_PROXY_PORT || '8788', 10) || 8788;

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir' && argv[i + 1]) {
      targetDir = argv[++i];
    } else if ((argv[i] === '--port' || argv[i] === '-p') && argv[i + 1]) {
      port = Number.parseInt(argv[++i], 10) || 8788;
    }
  }

  if (action === 'init') {
    const { devcontainerJsonPath, config } = initDevcontainerConfig(targetDir, { port });
    stderr.write(`Configured .devcontainer in ${devcontainerJsonPath}\n`);
    stdout.write(
      `${JSON.stringify({
        ok: true,
        devcontainerJsonPath,
        forwardPorts: config.forwardPorts,
        containerEnv: config.containerEnv
      })}\n`
    );
    return 0;
  }

  if (action === 'up' || action === 'exec') {
    const devcontainerBin = env.AI_PROXY_DEVCONTAINER_BIN || 'devcontainer';
    const extraArgs = argv.slice(1).filter((a, idx, arr) => {
      if (a === '--dir') return false;
      if (idx > 0 && arr[idx - 1] === '--dir') return false;
      return true;
    });
    const cmdArgs = [
      action,
      '--workspace-folder',
      path.resolve(targetDir),
      '--remote-env',
      'AI_PROXY_HOST=host.docker.internal',
      '--remote-env',
      `AI_PROXY_PORT=${port}`,
      '--remote-env',
      `AI_PROXY_URL=http://host.docker.internal:${port}`,
      ...extraArgs
    ];
    return execSpawn(devcontainerBin, cmdArgs, { env, stdout, stderr });
  }

  stderr.write(`Error: unknown devcontainer action "${action}". Expected init, up, or exec.\n`);
  return 2;
}
