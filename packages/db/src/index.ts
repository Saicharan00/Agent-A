import { join } from 'node:path';

// Placeholder until F02 (schema, migrations, repositories).
export const DB_FILENAME = 'agenta.db';

export function defaultDbPath(repoRoot: string): string {
  return join(repoRoot, 'data', DB_FILENAME);
}
