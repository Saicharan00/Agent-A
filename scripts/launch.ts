// One-command launch (F34). Usage: pnpm launch [-- --rebuild]
// `pnpm launch` installs dependencies first (package.json), then this script: builds the web app if the code changed
// since the last build → migrates the DB → makes sure the bot image exists → starts web + runner in production
// mode → prints the URL once /api/health answers through the web server.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE } from './image-build';

const STAMP = 'agenta-build-rev';

/** Rebuild when forced, never built, or built from another commit (`null` rev = not a git checkout). */
export function needsBuild(o: {
  force: boolean;
  hasBuild: boolean;
  stamp: string | null;
  rev: string | null;
}) {
  return o.force || !o.hasBuild || o.rev === null || o.stamp !== o.rev;
}

/** The URL the owner opens. Port publishing maps Windows localhost:<port> to the VM, whatever the bind host. */
export function appUrl(env: NodeJS.ProcessEnv): string {
  return `http://localhost:${Number(env.AGENTA_WEB_PORT) || 3000}`;
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

function step(msg: string): void {
  console.log(`\n▶ ${msg}`);
}

function run(cmd: string, args: string[], cwd: string): void {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`\nlaunch: \`${cmd} ${args.join(' ')}\` failed (exit ${res.status ?? res.signal}).`);
    process.exit(res.status ?? 1);
  }
}

function gitRev(repo: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const envFile = join(repo, '.env.local');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const port = Number(process.env.AGENTA_WEB_PORT) || 3000;
  const url = appUrl(process.env);

  if (await healthy(port)) {
    console.log(`Agent A is already running: ${url}`);
    return;
  }

  const nextDir = join(repo, 'apps', 'web', '.next');
  const stampFile = join(nextDir, STAMP);
  const rev = gitRev(repo);
  const build = needsBuild({
    force: process.argv.includes('--rebuild'),
    hasBuild: existsSync(join(nextDir, 'BUILD_ID')),
    stamp: existsSync(stampFile) ? readFileSync(stampFile, 'utf8').trim() : null,
    rev,
  });
  if (build) {
    step('Building the web app (production)');
    run('pnpm', ['--filter', '@agenta/web', 'build'], repo);
    if (rev) writeFileSync(stampFile, rev);
  } else step('Web app already built for this version');

  step('Migrating the database');
  run('pnpm', ['db:migrate'], repo);

  step(`Checking the bot image (${IMAGE}:latest)`);
  if (spawnSync('docker', ['version'], { stdio: 'ignore' }).status !== 0) {
    console.warn(
      '  Docker is not reachable: the app starts, but bot computers will not. See `pnpm run doctor`.',
    );
  } else if (spawnSync('docker', ['image', 'inspect', `${IMAGE}:latest`], { stdio: 'ignore' }).status !== 0) {
    console.log('  Not built yet; building it now (first time takes several minutes).');
    run('pnpm', ['image:build'], repo);
  } else console.log('  Present. (`pnpm run doctor` says if it is out of date.)');

  step('Starting web + runner (production)');
  const child = spawn('pnpm', ['start'], { cwd: repo, stdio: 'inherit' });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

  // Runner first (direct), so the web proxy doesn't log ECONNREFUSED while the runner boots.
  const runnerPort = Number(process.env.AGENTA_RUNNER_PORT) || 3001;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if ((await healthy(runnerPort)) && (await healthy(port))) {
      console.log(`\n✔ Agent A is running: ${url}  (Ctrl+C stops it)\n`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.warn(
    `\nlaunch: no answer from ${url}/api/health after 2 minutes; still waiting on the servers above.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
