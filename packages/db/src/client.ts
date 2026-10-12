import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'drizzle');

export type OpenDbOptions = {
  /** Run pending migrations right after opening (default true). */
  migrate?: boolean;
};

/**
 * Opens (creating if needed) the SQLite file with the pragmas every connection needs:
 * WAL, foreign keys on, busy_timeout 5000. Pass ':memory:' for a throwaway DB.
 */
export function openDb(file: string, opts: OpenDbOptions = {}): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  const db = drizzle({ client: sqlite, schema });
  if (opts.migrate ?? true) migrateDb(db);
  return db;
}

/** Applies pending drizzle-kit migrations. Idempotent: applied migrations are tracked in __drizzle_migrations. */
export function migrateDb(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

export function closeDb(db: Db): void {
  db.$client.close();
}
