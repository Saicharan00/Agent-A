import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildArgs, formatSize, syncCerts } from './image-build';

describe('image-build', () => {
  it('tags latest + sha, labels agenta=1 and forwards only set proxy vars', () => {
    const args = buildArgs({
      contextDir: '/ctx',
      sha: 'abc123',
      env: { HTTPS_PROXY: 'http://p:3128', NO_PROXY: 'localhost', SECRET: 'x' },
    });
    expect(args.slice(0, 5)).toEqual(['build', '-t', 'agenta-bot:latest', '-t', 'agenta-bot:abc123']);
    expect(args).toContain('agenta=1');
    expect(args).toContain('HTTPS_PROXY=http://p:3128');
    expect(args).toContain('NO_PROXY=localhost');
    expect(args.join(' ')).not.toContain('SECRET');
    expect(args).not.toContain('--no-cache');
    expect(args.at(-1)).toBe('/ctx');
  });

  it('adds --no-cache when asked', () => {
    expect(buildArgs({ contextDir: '/c', sha: 's', env: {}, noCache: true })).toContain('--no-cache');
  });

  it('syncCerts replaces stale certs and skips missing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'certs-'));
    writeFileSync(join(dir, 'README.md'), 'x');
    writeFileSync(join(dir, 'stale.crt'), 'old');
    const src = join(mkdtempSync(join(tmpdir(), 'ca-')), 'proxy-ca.crt');
    writeFileSync(src, 'CA');
    expect(syncCerts(dir, [src, '/nope/missing.crt'])).toEqual(['proxy-ca.crt']);
    expect(readdirSync(dir).sort()).toEqual(['README.md', 'proxy-ca.crt']);
  });

  it('formats sizes', () => {
    expect(formatSize(2_345_000_000)).toBe('2.35 GB');
    expect(formatSize(512_000_000)).toBe('512 MB');
  });
});
