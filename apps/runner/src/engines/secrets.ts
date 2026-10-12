import { existsSync, readFileSync, statSync } from 'node:fs';
import { parseEnv } from 'node:util';

/** Reads a secret by name. Values are never cached in logs or returned by any API. */
export type SecretSource = { get(name: string): string | undefined };

/**
 * Secrets from the shell environment first, then `<repo>/.env.local`, re-read whenever the file changes,
 * so the owner can paste a token and press "Re-check" without restarting the runner.
 * `shellEnv` must be a snapshot taken BEFORE .env.local was loaded into process.env: a variable the shell
 * sets (even to "") wins, which is how Playwright forces engines to "missing".
 */
export function envFileSource(opts: { shellEnv: NodeJS.ProcessEnv; envFile?: string }): SecretSource {
  let cache: { mtimeMs: number; size: number; values: Record<string, string | undefined> } | null = null;

  function fileValues(): Record<string, string | undefined> {
    const file = opts.envFile;
    if (!file || !existsSync(file)) return {};
    const st = statSync(file);
    if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.values;
    const values = parseEnv(readFileSync(file, 'utf8')) as Record<string, string | undefined>;
    cache = { mtimeMs: st.mtimeMs, size: st.size, values };
    return values;
  }

  return {
    get(name) {
      const raw = name in opts.shellEnv ? opts.shellEnv[name] : fileValues()[name];
      const v = raw?.trim();
      return v ? v : undefined;
    },
  };
}

/** Replaces every occurrence of the given secrets (and anything token-shaped) in `text`. */
export function redactSecrets(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('[redacted]');
  return out
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
}
