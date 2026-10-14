import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, createRepos, defaultDbPath, migrateDb, openDb, resolveDbPath, seedDb } from '../src/index';

const ALL_TABLES = [
  'approvals',
  'bot_connectors',
  'bot_mcp_access',
  'bot_thread_sessions',
  'bots',
  'connectors',
  'decisions',
  'engine_state',
  'goals',
  'guard_terms',
  'lessons',
  'mcp_servers',
  'memories',
  'messages',
  'notifications',
  'run_events',
  'runs',
  'schedule_runs',
  'schedules',
  'settings',
  'task_events',
  'tasks',
  'thread_members',
  'threads',
];

describe('db client', () => {
  const dirs: string[] = [];
  const tempFile = () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenta-db-'));
    dirs.push(dir);
    return join(dir, 'nested', 'agenta.db');
  };
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('creates every PLAN table from an empty file', () => {
    const db = openDb(tempFile());
    const tables = db.$client
      .prepare(
        // memories_fts* is the FTS5 index over memories (F22) and its shadow tables.
        "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '__drizzle%' and name not like 'memories_fts%' order by name",
      )
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(ALL_TABLES);
    expect(
      db.$client.prepare("select name from sqlite_master where name = 'memories_fts'").get(),
    ).toBeTruthy();
    closeDb(db);
  });

  it('sets WAL, foreign keys and busy_timeout', () => {
    const db = openDb(tempFile());
    expect(db.$client.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.$client.pragma('busy_timeout', { simple: true })).toBe(5000);
    closeDb(db);
  });

  it('migrates idempotently: twice in a row and across reopen', () => {
    const file = tempFile();
    const db = openDb(file);
    expect(() => migrateDb(db)).not.toThrow();
    const count = () =>
      db.$client.prepare('select count(*) n from __drizzle_migrations').get() as { n: number };
    const before = count().n;
    migrateDb(db);
    expect(count().n).toBe(before);
    closeDb(db);
    const again = openDb(file);
    expect(
      (again.$client.prepare('select count(*) n from __drizzle_migrations').get() as { n: number }).n,
    ).toBe(before);
    closeDb(again);
  });

  it('enforces foreign keys', () => {
    const db = openDb(tempFile());
    const repos = createRepos(db);
    expect(() =>
      repos.runs.create({ botId: 'bot_missing', trigger: 'user', engine: 'mock', prompt: 'x' }),
    ).toThrow(/FOREIGN KEY/);
    closeDb(db);
  });

  it('seeds the Echo Bot and its DM thread idempotently', () => {
    const db = openDb(tempFile());
    const repos = createRepos(db);
    const first = seedDb(repos);
    expect(first.created).toBe(true);
    expect(first.bot).toMatchObject({ name: 'Echo Bot', engine: 'mock', slug: 'echo-bot' });
    expect(repos.threads.listMembers(first.thread.id).map((b) => b.id)).toEqual([first.bot.id]);
    const second = seedDb(repos);
    expect(second).toMatchObject({
      created: false,
      bot: { id: first.bot.id },
      thread: { id: first.thread.id },
    });
    expect(repos.bots.list()).toHaveLength(1);
    expect(repos.threads.list()).toHaveLength(1);
    closeDb(db);
  });

  it('resolves the DB path from AGENTA_DB_PATH', () => {
    expect(defaultDbPath('/repo')).toBe('/repo/data/agenta.db');
    expect(resolveDbPath('/repo', {})).toBe('/repo/data/agenta.db');
    expect(resolveDbPath('/repo', { AGENTA_DB_PATH: 'data/e2e/x.db' })).toBe('/repo/data/e2e/x.db');
    expect(resolveDbPath('/repo', { AGENTA_DB_PATH: '/tmp/x.db' })).toBe('/tmp/x.db');
    expect(resolveDbPath('/repo', { AGENTA_DB_PATH: ':memory:' })).toBe(':memory:');
  });
});
