import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPath, run, scanText } from './check-secrets.ts';

// Fake secrets are assembled at runtime so this file never trips the scanner itself.
const fake = {
  sk: 'sk-' + 'ant-api03-' + 'A'.repeat(32),
  ghp: 'ghp' + '_' + 'b'.repeat(36),
  pat: 'github' + '_pat_' + '11ABCDEFG0123456789_' + 'c'.repeat(40),
  oauth: 'CLAUDE_CODE_' + 'OAUTH_TOKEN=' + 'sk-ant-oat01-' + 'd'.repeat(20),
  key: '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----',
};

describe('check-secrets', () => {
  it.each(Object.entries(fake))('flags %s', (_name, secret) => {
    expect(scanText('x.ts', `const a = 1;\n${secret}\n`).length).toBeGreaterThan(0);
  });

  it('reports the line number', () => {
    expect(scanText('x.ts', `a\nb\n${fake.ghp}`)[0]?.line).toBe(3);
  });

  it('ignores harmless text and empty env placeholders', () => {
    expect(scanText('x.ts', 'const risk = "sk-short";\nCLAUDE_CODE_' + 'OAUTH_TOKEN=\n')).toEqual([]);
  });

  it('flags data/, secrets/ and .env paths but allows .env.example', () => {
    expect(checkPath('data/agenta.db')).toHaveLength(1);
    expect(checkPath('apps/x/secrets/a.txt')).toHaveLength(1);
    expect(checkPath('.env.local')).toHaveLength(1);
    expect(checkPath('.env.example')).toEqual([]);
    expect(checkPath('apps/web/lib/database.ts')).toEqual([]);
  });

  it('scans files passed explicitly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenta-secrets-'));
    const file = join(dir, 'planted.txt');
    writeFileSync(file, `token: ${fake.pat}\n`);
    expect(run([file])).toHaveLength(1);
  });
});
