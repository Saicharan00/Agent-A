// SMOKE=1 pnpm smoke:github (F29): `gh auth status` in a throwaway bot container with exactly the env an enabled
// bot gets (GH_TOKEN from GITHUB_TOKEN in .env.local). Calls only the GitHub API, no engine.
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { envFileSource } from '../../apps/runner/src/engines/secrets';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const enabled = process.env.SMOKE === '1';
const token = envFileSource({ shellEnv: process.env, envFile: join(repo, '.env.local') }).get('GITHUB_TOKEN');
const PROXY = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];

describe.runIf(enabled)('smoke: GitHub connector', () => {
  it.runIf(Boolean(token))('gh is signed in inside an enabled bot', () => {
    const args = ['run', '--rm', '--label', 'agenta=1', '--label', 'agenta.purpose=smoke', '-e', 'GH_TOKEN'];
    for (const n of PROXY) if (process.env[n]) args.push('-e', n);
    // The token goes through the child env, never argv; gh prints it masked.
    const out = execFileSync('docker', [...args, 'agenta-bot:latest', 'sh', '-c', 'gh auth status 2>&1'], {
      encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: token! },
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toMatch(/Logged in to github\.com/);
    expect(out).not.toContain(token!);
  });

  it.skipIf(Boolean(token))('needs GITHUB_TOKEN in .env.local (HUMAN_TODO)', () =>
    expect(token).toBeUndefined(),
  );
});

describe.skipIf(enabled)('smoke: GitHub connector', () => {
  it('is skipped without SMOKE=1', () => expect(enabled).toBe(false));
});
