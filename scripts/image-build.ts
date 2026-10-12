// Builds the bot computer image: agenta-bot:latest + agenta-bot:<git-sha> (PLAN.md F04).
// Usage: pnpm image:build [-- --no-cache]
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IMAGE = 'agenta-bot';
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
// CA bundles that must be trusted inside the image (the Docker Sandbox proxy intercepts some TLS).
export const DEFAULT_CA_FILES = ['/usr/local/share/ca-certificates/proxy-ca.crt'];

/** `docker build` arguments: tags, label, proxy build args (Docker does not forward the env by itself). */
export function buildArgs(opts: {
  contextDir: string;
  sha: string;
  env: NodeJS.ProcessEnv;
  noCache?: boolean;
}): string[] {
  const args = ['build', '-t', `${IMAGE}:latest`, '-t', `${IMAGE}:${opts.sha}`];
  args.push('--label', 'agenta=1', '--label', `org.opencontainers.image.revision=${opts.sha}`);
  for (const name of PROXY_VARS) {
    const value = opts.env[name];
    if (value) args.push('--build-arg', `${name}=${value}`);
  }
  if (opts.noCache) args.push('--no-cache');
  args.push(opts.contextDir);
  return args;
}

/** Short git sha of HEAD, with `-dirty` when the bot image sources have uncommitted changes. */
export function gitSha(repo: string): string {
  const git = (...a: string[]) =>
    execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const sha = git('rev-parse', '--short=12', 'HEAD');
    return git('status', '--porcelain', '--', 'docker/bot') ? `${sha}-dirty` : sha;
  } catch {
    return 'nogit';
  }
}

/** Replaces the *.crt files in certs/ with the CA files that exist on this machine. Returns their names. */
export function syncCerts(certsDir: string, caFiles: string[]): string[] {
  mkdirSync(certsDir, { recursive: true });
  for (const f of readdirSync(certsDir)) if (f.endsWith('.crt')) rmSync(join(certsDir, f));
  const copied: string[] = [];
  for (const file of caFiles) {
    if (!existsSync(file)) continue;
    copyFileSync(file, join(certsDir, basename(file)));
    copied.push(basename(file));
  }
  return copied;
}

export function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(0)} MB`;
}

function main(): void {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const contextDir = join(repo, 'docker', 'bot');
  const sha = gitSha(repo);
  const certs = syncCerts(join(contextDir, 'certs'), DEFAULT_CA_FILES);
  const noCache = process.argv.includes('--no-cache');

  console.log(`Building ${IMAGE}:latest and ${IMAGE}:${sha}`);
  console.log(`  extra CAs: ${certs.length ? certs.join(', ') : 'none'}`);
  const started = Date.now();
  const res = spawnSync('docker', buildArgs({ contextDir, sha, env: process.env, noCache }), {
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    console.error(`\nimage:build failed (docker build exited ${res.status ?? res.signal}).`);
    process.exit(res.status ?? 1);
  }

  const size = Number(
    execFileSync('docker', ['image', 'inspect', `${IMAGE}:latest`, '--format', '{{.Size}}'], {
      encoding: 'utf8',
    }).trim(),
  );
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\nBuilt ${IMAGE}:latest (= ${IMAGE}:${sha}) in ${secs}s, size ${formatSize(size)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
