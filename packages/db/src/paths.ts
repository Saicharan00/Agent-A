import { isAbsolute, join, resolve } from 'node:path';

export const DB_FILENAME = 'agenta.db';

export function defaultDbPath(repoRoot: string): string {
  return join(repoRoot, 'data', DB_FILENAME);
}

/** AGENTA_DB_PATH (absolute, or relative to the repo root) or data/agenta.db. */
export function resolveDbPath(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const p = env.AGENTA_DB_PATH?.trim();
  if (!p) return defaultDbPath(repoRoot);
  return p === ':memory:' || isAbsolute(p) ? p : resolve(repoRoot, p);
}
