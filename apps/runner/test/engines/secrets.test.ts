import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envFileSource, redactSecrets } from '../../src/engines/secrets';
import { FAKE_CLAUDE_TOKEN, FAKE_OTHER_CLAUDE_TOKEN, tokenLine } from './helpers';

describe('envFileSource', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenta-secrets-'));
    file = join(dir, '.env.local');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads .env.local and picks up edits without a restart', () => {
    const src = envFileSource({ shellEnv: {}, envFile: file });
    expect(src.get('CLAUDE_CODE_OAUTH_TOKEN')).toBeUndefined();
    writeFileSync(file, `FOO=1\n${tokenLine(FAKE_CLAUDE_TOKEN)}`);
    expect(src.get('CLAUDE_CODE_OAUTH_TOKEN')).toBe(FAKE_CLAUDE_TOKEN);
    writeFileSync(file, tokenLine(''));
    expect(src.get('CLAUDE_CODE_OAUTH_TOKEN')).toBeUndefined();
  });

  it('lets the shell environment win, even when it sets an empty value', () => {
    writeFileSync(file, tokenLine(FAKE_CLAUDE_TOKEN));
    expect(
      envFileSource({ shellEnv: { CLAUDE_CODE_OAUTH_TOKEN: '' }, envFile: file }).get(
        'CLAUDE_CODE_OAUTH_TOKEN',
      ),
    ).toBeUndefined();
    expect(
      envFileSource({ shellEnv: { CLAUDE_CODE_OAUTH_TOKEN: ' x ' }, envFile: file }).get(
        'CLAUDE_CODE_OAUTH_TOKEN',
      ),
    ).toBe('x');
  });
});

describe('redactSecrets', () => {
  it('masks known secrets and token-shaped strings', () => {
    const out = redactSecrets(
      `token ${FAKE_CLAUDE_TOKEN} and ${FAKE_OTHER_CLAUDE_TOKEN} and eyJabcdefghijkl.eyJmno.sig`,
      [FAKE_CLAUDE_TOKEN],
    );
    expect(out).not.toContain('FAKEtoken');
    expect(out).not.toContain('otherTOKEN');
    expect(out).not.toContain('eyJabcdefghijkl');
    expect(out).toContain('[redacted]');
  });
});
