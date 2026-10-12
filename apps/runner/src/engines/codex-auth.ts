import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

// Codex ChatGPT login = ~/.codex/auth.json. One shared copy lives in data/secrets/codex/auth.json (mode 600);
// each bot gets a copy in its home before it starts, and Codex token refreshes are copied back after runs.

export const sharedCodexAuthPath = (secretsDir: string) => join(secretsDir, 'codex', 'auth.json');
export const botCodexAuthPath = (home: string) => join(home, '.codex', 'auth.json');

export type CodexAuthInfo = {
  kind: 'chatgpt' | 'api-key';
  accountId?: string;
  plan?: string;
};

export type ParsedCodexAuth = { ok: true; info: CodexAuthInfo } | { ok: false; reason: string };

function jwtPayload(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string') return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const json: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Validates auth.json's shape without ever returning token values. */
export function parseCodexAuth(text: string): ParsedCodexAuth {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'auth.json is not valid JSON' };
  }
  if (!json || typeof json !== 'object') return { ok: false, reason: 'auth.json is not a JSON object' };
  const obj = json as Record<string, unknown>;
  const tokens = obj.tokens as Record<string, unknown> | null | undefined;
  if (tokens && typeof tokens === 'object') {
    if (typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string') {
      return { ok: false, reason: 'auth.json has no access/refresh token' };
    }
    const claims = jwtPayload(tokens.id_token);
    if (!claims) return { ok: false, reason: 'auth.json has a malformed id_token' };
    const openai = claims['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
    const accountId =
      typeof tokens.account_id === 'string'
        ? tokens.account_id
        : typeof openai?.chatgpt_account_id === 'string'
          ? openai.chatgpt_account_id
          : undefined;
    const plan = typeof openai?.chatgpt_plan_type === 'string' ? openai.chatgpt_plan_type : undefined;
    return { ok: true, info: { kind: 'chatgpt', accountId, plan } };
  }
  if (typeof obj.OPENAI_API_KEY === 'string' && obj.OPENAI_API_KEY) {
    return { ok: true, info: { kind: 'api-key' } };
  }
  return { ok: false, reason: 'auth.json has neither ChatGPT tokens nor an API key' };
}

export function readCodexAuth(path: string): ParsedCodexAuth | null {
  if (!existsSync(path)) return null;
  return parseCodexAuth(readFileSync(path, 'utf8'));
}

/** Writes `data` to `path` atomically with mode 600 (directory 700). */
export function writePrivate(path: string, data: Buffer | string, mtime?: Date): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  if (mtime) {
    // Keep the source's mtime so "which copy is newer" compares token ages, not copy times.
    utimesSync(path, mtime, mtime);
  }
}

/** Tightens a secret file to 600 if it is group/world readable. Returns true when it changed. */
export function ensurePrivateMode(path: string): boolean {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) === 0) return false;
  chmodSync(path, 0o600);
  return true;
}

/**
 * Cross-process lock via an O_EXCL lock file next to `path`. Stale locks (older than `staleMs`,
 * e.g. from a crashed process) are broken.
 */
export async function withFileLock<T>(
  path: string,
  fn: () => T | Promise<T>,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx', 0o600));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > (opts.staleMs ?? 30_000)) unlinkSync(lock);
      } catch {
        // lock vanished between checks: retry
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for lock ${lock}`, { cause: err });
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already gone
    }
  }
}

export type SyncInResult = 'no-shared' | 'invalid-shared' | 'copied' | 'up-to-date' | 'kept-bot-login';
export type SyncBackResult =
  | 'no-shared'
  | 'no-bot-file'
  | 'unchanged'
  | 'invalid'
  | 'different-account'
  | 'shared-newer'
  | 'copied-back';

export function sameAccount(a: CodexAuthInfo, b: CodexAuthInfo): boolean {
  return a.kind === b.kind && (a.accountId ?? null) === (b.accountId ?? null);
}

/**
 * Before a bot starts / runs Codex: make its auth.json match the shared one.
 * A bot copy that is newer than the shared file and belongs to the same account is a token refresh
 * that was not copied back yet, so it is copied back instead. A bot logged in to a *different*
 * account (per-bot fallback login) is left alone.
 */
export async function syncCodexAuthIn(sharedPath: string, botPath: string): Promise<SyncInResult> {
  if (!existsSync(sharedPath)) return 'no-shared';
  return withFileLock(sharedPath, () => {
    const shared = readFileSync(sharedPath);
    const sharedParsed = parseCodexAuth(shared.toString('utf8'));
    if (!sharedParsed.ok) return 'invalid-shared';
    const sharedMtime = statSync(sharedPath).mtime;
    if (existsSync(botPath)) {
      const bot = readFileSync(botPath);
      if (bot.equals(shared)) {
        ensurePrivateMode(botPath);
        return 'up-to-date';
      }
      const botParsed = parseCodexAuth(bot.toString('utf8'));
      if (botParsed.ok && !sameAccount(botParsed.info, sharedParsed.info)) return 'kept-bot-login';
      const botMtime = statSync(botPath).mtime;
      if (botParsed.ok && botMtime > sharedMtime) {
        writePrivate(sharedPath, bot, botMtime);
        return 'up-to-date';
      }
    }
    writePrivate(botPath, shared, sharedMtime);
    return 'copied';
  });
}

/** After a Codex run: copy a refreshed token from the bot's home back to the shared file. */
export async function syncCodexAuthBack(sharedPath: string, botPath: string): Promise<SyncBackResult> {
  if (!existsSync(sharedPath)) return 'no-shared';
  if (!existsSync(botPath)) return 'no-bot-file';
  return withFileLock(sharedPath, () => {
    const shared = readFileSync(sharedPath);
    const bot = readFileSync(botPath);
    if (bot.equals(shared)) return 'unchanged';
    const botParsed = parseCodexAuth(bot.toString('utf8'));
    if (!botParsed.ok) return 'invalid';
    const sharedParsed = parseCodexAuth(shared.toString('utf8'));
    if (sharedParsed.ok && !sameAccount(botParsed.info, sharedParsed.info)) return 'different-account';
    const botMtime = statSync(botPath).mtime;
    if (botMtime <= statSync(sharedPath).mtime) return 'shared-newer';
    writePrivate(sharedPath, bot, botMtime);
    return 'copied-back';
  });
}
