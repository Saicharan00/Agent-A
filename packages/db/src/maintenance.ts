import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Db } from './client';

/**
 * Writes a consistent copy of the live DB to `file` with `VACUUM INTO` (F32): safe while the runner keeps writing,
 * and the copy is a plain single-file DB (no -wal). Refuses to overwrite an existing file.
 */
export function backupDbTo(db: Db, file: string): void {
  if (existsSync(file)) throw new Error(`Refusing to overwrite ${file}`);
  db.$client.prepare('VACUUM INTO ?').run(file);
}

/**
 * Factory reset (F32): deletes every row of every ordinary table, keeping the schema and the applied-migrations log.
 * FTS shadow tables are left to the triggers that keep them in sync. Returns the wiped table names.
 */
export function wipeAllData(db: Db): string[] {
  const sqlite = db.$client;
  const tables = (sqlite.pragma('table_list') as { schema: string; name: string; type: string }[])
    .filter(
      (t) =>
        t.schema === 'main' &&
        t.type === 'table' &&
        !t.name.startsWith('sqlite_') &&
        t.name !== '__drizzle_migrations',
    )
    .map((t) => t.name);
  // foreign_keys can only change outside a transaction; rows reference each other in every direction.
  sqlite.pragma('foreign_keys = OFF');
  try {
    sqlite.transaction(() => {
      for (const t of tables) sqlite.prepare(`DELETE FROM "${t.replaceAll('"', '""')}"`).run();
    })();
  } finally {
    sqlite.pragma('foreign_keys = ON');
  }
  return tables;
}

/** `PRAGMA integrity_check` on a DB file opened read-only (nothing is written to it): 'ok' when healthy. */
export function checkDbFile(file: string): string {
  const sqlite = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return String(sqlite.pragma('integrity_check', { simple: true }));
  } finally {
    sqlite.close();
  }
}
