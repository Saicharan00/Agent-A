import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseCodexAuth,
  syncCodexAuthBack,
  syncCodexAuthIn,
  withFileLock,
  writePrivate,
} from '../../src/engines/codex-auth';
import { fakeCodexAuth } from './helpers';

const mode = (p: string) => statSync(p).mode & 0o777;
const setAge = (p: string, secondsAgo: number) => {
  const t = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(p, t, t);
};

describe('parseCodexAuth', () => {
  it('accepts a ChatGPT login and reports plan/account without tokens', () => {
    const r = parseCodexAuth(fakeCodexAuth({ plan: 'plus', account: 'acct_9' }));
    expect(r).toEqual({ ok: true, info: { kind: 'chatgpt', plan: 'plus', accountId: 'acct_9' } });
  });
  it('accepts an API key file', () => {
    expect(parseCodexAuth(JSON.stringify({ OPENAI_API_KEY: 'sk-x' }))).toEqual({
      ok: true,
      info: { kind: 'api-key' },
    });
  });
  it('rejects junk', () => {
    expect(parseCodexAuth('nope').ok).toBe(false);
    expect(parseCodexAuth('{}').ok).toBe(false);
    expect(
      parseCodexAuth(JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'b', id_token: 'bad' } }))
        .ok,
    ).toBe(false);
  });
});

describe('codex auth copy-in / copy-back', () => {
  let dir: string;
  let shared: string;
  let bot: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenta-codex-'));
    shared = join(dir, 'secrets', 'codex', 'auth.json');
    bot = join(dir, 'home', '.codex', 'auth.json');
    mkdirSync(join(dir, 'home', '.codex'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('does nothing without a shared file (per-bot fallback untouched)', async () => {
    writeFileSync(bot, fakeCodexAuth({ account: 'mine' }));
    expect(await syncCodexAuthIn(shared, bot)).toBe('no-shared');
    expect(await syncCodexAuthBack(shared, bot)).toBe('no-shared');
    expect(existsSync(shared)).toBe(false);
  });

  it('copies the shared login into the bot home with mode 600', async () => {
    writePrivate(shared, fakeCodexAuth());
    expect(await syncCodexAuthIn(shared, bot)).toBe('copied');
    expect(readFileSync(bot, 'utf8')).toBe(readFileSync(shared, 'utf8'));
    expect(mode(bot)).toBe(0o600);
    expect(mode(shared)).toBe(0o600);
    expect(await syncCodexAuthIn(shared, bot)).toBe('up-to-date');
  });

  it('copies a refreshed token back after a run, and other bots pick it up', async () => {
    writePrivate(shared, fakeCodexAuth({ version: 1 }));
    setAge(shared, 60);
    await syncCodexAuthIn(shared, bot);
    // Codex refreshed its token inside the container.
    writeFileSync(bot, fakeCodexAuth({ version: 2 }));
    expect(await syncCodexAuthBack(shared, bot)).toBe('copied-back');
    expect(readFileSync(shared, 'utf8')).toBe(fakeCodexAuth({ version: 2 }));
    expect(mode(shared)).toBe(0o600);
    expect(await syncCodexAuthBack(shared, bot)).toBe('unchanged');

    const other = join(dir, 'home2', '.codex', 'auth.json');
    writePrivate(other, fakeCodexAuth({ version: 1 }));
    setAge(other, 120);
    expect(await syncCodexAuthIn(shared, other)).toBe('copied');
    expect(readFileSync(other, 'utf8')).toBe(fakeCodexAuth({ version: 2 }));
  });

  it('never copies back an older, invalid or different-account file', async () => {
    writePrivate(shared, fakeCodexAuth({ version: 3 }));
    writeFileSync(bot, fakeCodexAuth({ version: 2 }));
    setAge(bot, 60);
    expect(await syncCodexAuthBack(shared, bot)).toBe('shared-newer');

    writeFileSync(bot, '{broken');
    expect(await syncCodexAuthBack(shared, bot)).toBe('invalid');

    writeFileSync(bot, fakeCodexAuth({ account: 'someone-else', version: 9 }));
    expect(await syncCodexAuthBack(shared, bot)).toBe('different-account');
    expect(await syncCodexAuthIn(shared, bot)).toBe('kept-bot-login');
    expect(readFileSync(shared, 'utf8')).toBe(fakeCodexAuth({ version: 3 }));
  });

  it('copy-in rescues a newer bot copy that was not copied back yet', async () => {
    writePrivate(shared, fakeCodexAuth({ version: 1 }));
    setAge(shared, 60);
    writeFileSync(bot, fakeCodexAuth({ version: 2 }));
    expect(await syncCodexAuthIn(shared, bot)).toBe('up-to-date');
    expect(readFileSync(shared, 'utf8')).toBe(fakeCodexAuth({ version: 2 }));
  });

  it('serialises concurrent writers with the file lock and breaks stale locks', async () => {
    const order: string[] = [];
    const slow = (name: string) =>
      withFileLock(shared, async () => {
        order.push(`${name}:in`);
        await new Promise((r) => setTimeout(r, 30));
        order.push(`${name}:out`);
      });
    await Promise.all([slow('a'), slow('b')]);
    expect(order).toEqual(['a:in', 'a:out', 'b:in', 'b:out']);

    mkdirSync(join(dir, 'secrets', 'codex'), { recursive: true });
    writeFileSync(`${shared}.lock`, '');
    setAge(`${shared}.lock`, 120);
    expect(await withFileLock(shared, () => 'ok', { timeoutMs: 500 })).toBe('ok');
    expect(existsSync(`${shared}.lock`)).toBe(false);
  });
});
