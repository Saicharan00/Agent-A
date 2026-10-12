// Human step helpers (F06): log the bot engines in to the owner's subscriptions.
//   pnpm auth:claude  → `claude setup-token` in a throwaway bot container, then saves the pasted token to .env.local
//   pnpm auth:codex   → `codex login --device-auth` in a throwaway bot container, then saves
//                       ~/.codex/auth.json to data/secrets/codex/auth.json (mode 600)
// Run these in an interactive sandbox shell (they need a TTY), never from an automated test.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { CLAUDE_TOKEN_VAR, claudeTokenProblem } from '../apps/runner/src/engines/claude-token';
import { parseCodexAuth, sharedCodexAuthPath, writePrivate } from '../apps/runner/src/engines/codex-auth';

const IMAGE = 'agenta-bot:latest';
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];

/** Sets KEY=value in a dotenv text, replacing an existing (possibly commented-out) line or appending. */
export function upsertEnvVar(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^#?\\s*${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  const sep = text === '' || text.endsWith('\n') ? '' : '\n';
  return `${text}${sep}${line}\n`;
}

/** `docker run` args for an interactive, throwaway bot container (labelled agenta=1). */
export function dockerRunArgs(
  cmd: string[],
  opts: { mounts?: string[]; env?: NodeJS.ProcessEnv } = {},
): string[] {
  const env = opts.env ?? process.env;
  const args = ['run', '--rm', '-it', '--label', 'agenta=1', '--label', 'agenta.purpose=login'];
  for (const name of PROXY_VARS) if (env[name]) args.push('-e', name); // value comes from this process's env
  for (const m of opts.mounts ?? []) args.push('-v', m);
  return [...args, IMAGE, ...cmd];
}

function docker(args: string[]): number {
  const r = spawnSync('docker', args, { stdio: 'inherit' });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

/** Reads one line without echoing it (so the token never shows on screen or in scrollback). */
function askHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const muted = new Writable({ write: (_c, _e, cb) => cb() });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  return new Promise((done) =>
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      done(answer.trim());
    }),
  );
}

async function loginClaude(repo: string): Promise<void> {
  console.log('Starting `claude setup-token` in a throwaway bot container.');
  console.log('Open the link it prints, approve in your browser, and paste the code back when asked.\n');
  const code = docker(dockerRunArgs(['claude', 'setup-token']));
  if (code !== 0) console.warn(`\nclaude setup-token exited with ${code}.`);
  const token = await askHidden(
    `\nPaste the token it printed (input hidden; empty to skip and edit .env.local by hand): `,
  );
  if (!token) {
    console.log(`Skipped. Add ${CLAUDE_TOKEN_VAR}=… to .env.local yourself.`);
    return;
  }
  const problem = claudeTokenProblem(token);
  if (problem) {
    console.error(problem);
    process.exitCode = 1;
    return;
  }
  const envFile = join(repo, '.env.local');
  const before = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  writeFileSync(envFile, upsertEnvVar(before, CLAUDE_TOKEN_VAR, token), { mode: 0o600 });
  console.log(`Saved ${CLAUDE_TOKEN_VAR} to .env.local. Open Settings → Engines and press "Re-check".`);
}

function loginCodex(repo: string): void {
  // A VM-disk temp dir mounted as the container's ~/.codex (uid 1000 on both sides).
  const tmp = mkdtempSync(join(tmpdir(), 'agenta-codex-login-'));
  try {
    console.log('Starting `codex login --device-auth` in a throwaway bot container.');
    console.log('Open the link it prints and enter the code shown.\n');
    const code = docker(
      dockerRunArgs(['codex', 'login', '--device-auth'], { mounts: [`${tmp}:/home/bot/.codex`] }),
    );
    const file = join(tmp, 'auth.json');
    if (code !== 0 || !existsSync(file)) {
      console.error(`\nCodex login did not complete (exit ${code}); nothing was saved.`);
      process.exitCode = 1;
      return;
    }
    const data = readFileSync(file);
    const parsed = parseCodexAuth(data.toString('utf8'));
    if (!parsed.ok) {
      console.error(`Codex wrote an unexpected auth.json (${parsed.reason}); nothing was saved.`);
      process.exitCode = 1;
      return;
    }
    const target = sharedCodexAuthPath(join(repo, 'data', 'secrets'));
    writePrivate(target, data);
    console.log(
      `Saved the Codex login to ${target} (mode 600). Open Settings → Engines and press "Re-check".`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const which = process.argv[2];
  if (!process.stdin.isTTY) {
    console.error('This needs an interactive terminal (run it in a sandbox shell, not from a script).');
    process.exit(1);
  }
  if (which === 'claude') await loginClaude(repo);
  else if (which === 'codex') loginCodex(repo);
  else {
    console.error('Usage: tsx scripts/engine-login.ts claude|codex');
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
