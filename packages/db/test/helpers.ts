import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { type Db, type Repos, closeDb, createRepos, openDb } from '../src/index';

export type TestDb = { db: Db; repos: Repos; file: string };

/** Each test gets a fresh, migrated SQLite file in its own temp dir (removed afterwards). */
export function useTestDb(): TestDb {
  const ctx = {} as TestDb;
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenta-db-'));
    ctx.file = join(dir, 'test.db');
    ctx.db = openDb(ctx.file);
    ctx.repos = createRepos(ctx.db);
  });
  afterEach(() => {
    closeDb(ctx.db);
    rmSync(dir, { recursive: true, force: true });
  });
  return ctx;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
