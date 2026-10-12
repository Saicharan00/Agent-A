// SMOKE=1 pnpm smoke:auth — ONE short prompt per configured engine, run in a throwaway bot container with
// exactly the credentials the runner would use. Costs a tiny amount of subscription usage.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLAUDE_TOKEN_VAR } from '../../apps/runner/src/engines/claude-token';
import {
  sharedCodexAuthPath,
  syncCodexAuthBack,
  syncCodexAuthIn,
} from '../../apps/runner/src/engines/codex-auth';
import { envFileSource } from '../../apps/runner/src/engines/secrets';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const enabled = process.env.SMOKE === '1';
const token = envFileSource({ shellEnv: {}, envFile: join(repo, '.env.local') }).get(CLAUDE_TOKEN_VAR);
const codexShared = sharedCodexAuthPath(join(repo, 'data', 'secrets'));
const PROXY = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
const PROMPT = 'Reply with exactly the two letters OK and nothing else.';

function dockerRun(cmd: string[], opts: { env?: Record<string, string>; mounts?: string[] } = {}): string {
  const args = ['run', '--rm', '--label', 'agenta=1', '--label', 'agenta.purpose=smoke'];
  for (const n of PROXY) if (process.env[n]) args.push('-e', n);
  for (const n of Object.keys(opts.env ?? {})) args.push('-e', n); // values via the child env, not argv
  for (const m of opts.mounts ?? []) args.push('-v', m);
  return execFileSync('docker', [...args, 'agenta-bot:latest', ...cmd], {
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
    timeout: 170_000,
  });
}

describe.runIf(enabled)('smoke: engine auth (real engines)', () => {
  it.runIf(Boolean(token))('Claude answers with the subscription token', () => {
    const out = dockerRun(['claude', '-p', PROMPT, '--output-format', 'text'], {
      env: { [CLAUDE_TOKEN_VAR]: token! },
    });
    expect(out.trim()).toMatch(/^OK\.?$/);
  });

  it.runIf(existsSync(codexShared))('Codex answers with the shared ChatGPT login', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agenta-smoke-codex-'));
    const botAuth = join(home, 'auth.json');
    try {
      await syncCodexAuthIn(codexShared, botAuth);
      const out = dockerRun(
        [
          'codex',
          'exec',
          '--skip-git-repo-check',
          '--color',
          'never',
          '-o',
          '/home/bot/.codex/last.txt',
          PROMPT,
        ],
        { mounts: [`${home}:/home/bot/.codex`] },
      );
      expect(out).toBeDefined();
      const last = execFileSync('cat', [join(home, 'last.txt')], { encoding: 'utf8' });
      expect(last.trim()).toMatch(/^OK\.?$/);
      await syncCodexAuthBack(codexShared, botAuth);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe.skipIf(enabled)('smoke: engine auth', () => {
  it('is skipped without SMOKE=1', () => expect(enabled).toBe(false));
});
