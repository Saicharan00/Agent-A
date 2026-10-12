import { describe, expect, it } from 'vitest';
import { dockerRunArgs, upsertEnvVar } from './engine-login';

describe('engine-login helpers', () => {
  it('upserts a dotenv variable without touching other lines', () => {
    expect(upsertEnvVar('', 'K', 'v')).toBe('K=v\n');
    expect(upsertEnvVar('A=1', 'K', 'v')).toBe('A=1\nK=v\n');
    expect(upsertEnvVar('A=1\nK=old\nB=2\n', 'K', 'v')).toBe('A=1\nK=v\nB=2\n');
    expect(upsertEnvVar('# K=\nA=1\n', 'K', 'v')).toBe('K=v\nA=1\n');
  });

  it('runs a labelled throwaway container and passes proxy vars by name only', () => {
    const args = dockerRunArgs(['codex', 'login'], {
      env: { HTTPS_PROXY: 'http://secret-proxy:3128', PATH: '/bin' },
      mounts: ['/tmp/x:/home/bot/.codex'],
    });
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '-it']);
    expect(args).toContain('agenta=1');
    expect(args.join(' ')).toContain('-e HTTPS_PROXY');
    expect(args.join(' ')).not.toContain('secret-proxy');
    expect(args.slice(-3)).toEqual(['agenta-bot:latest', 'codex', 'login']);
  });
});
