import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { type Db, type Repos, closeDb, createRepos, openDb, wipeAllData } from '@agenta/db';
import { SHARED_LAYOUT } from '@agenta/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOME_SECRETS, createBackup, listBackups, restoreBackup } from '../../src/backup/archive';
import { BackupService } from '../../src/backup/service';
import { registerBackupRoutes } from '../../src/backup/routes';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/server';
import { silent } from '../runs/helpers';

/** Every row of every ordinary table, for "data identical" checks. */
function dump(db: Db): Record<string, unknown[]> {
  const tables = (db.$client.pragma('table_list') as { name: string; type: string; schema: string }[]).filter(
    (t) => t.schema === 'main' && t.type === 'table' && !t.name.startsWith('sqlite_'),
  );
  return Object.fromEntries(
    tables.map((t) => [t.name, db.$client.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all()]),
  );
}

/** path → content of every file under `dir`. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, 'utf8');
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

function put(path: string, body: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

const tarList = (file: string) => execFileSync('tar', ['-tzf', file], { encoding: 'utf8' });

describe('backup & restore (F32)', () => {
  let dir: string;
  let db: Db;
  let repos: Repos;
  let paths: { backupsDir: string; botsDir: string; sharedDir: string };
  let dbPath: string;
  let botId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenta-backup-'));
    dbPath = join(dir, 'data', 'agenta.db');
    db = openDb(dbPath);
    repos = createRepos(db);
    paths = {
      backupsDir: join(dir, 'data', 'backups'),
      botsDir: join(dir, 'data', 'bots'),
      sharedDir: join(dir, 'data', 'shared'),
    };
    const bot = repos.bots.create({ name: 'Writer', engine: 'mock' });
    botId = bot.id;
    const thr = repos.threads.create({ kind: 'dm', title: 'Writer', memberBotIds: [bot.id] });
    repos.messages.create({ threadId: thr.id, authorType: 'user', contentMd: 'hello' });
    repos.memories.create({ scope: 'shared', title: 'Style', contentMd: 'Short sentences', tags: ['style'] });
    repos.lessons.create({ topic: 'Testing', lessonMd: 'Test the restore' });
    const home = join(paths.botsDir, bot.id, 'home');
    put(join(home, 'work', 'draft.md'), 'draft v1');
    put(join(home, 'CLAUDE.md'), '# Writer');
    put(join(home, 'node_modules', 'x', 'index.js'), 'cache');
    put(join(home, '.cache', 'pip', 'blob'), 'cache');
    for (const s of HOME_SECRETS) put(join(home, s === '.ssh' ? '.ssh/id_ed25519' : s), `secret ${s}`);
    put(join(paths.sharedDir, 'knowledge', 'style.md'), 'Short sentences');
    put(join(dir, 'data', 'secrets', 'codex', 'auth.json'), '{"token":"top-secret"}');
  });

  afterEach(() => {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('backup → wipe → restore gives identical data, keeps home credentials and archives no secrets', async () => {
    const before = dump(db);
    const filesBefore = { bots: tree(paths.botsDir), shared: tree(paths.sharedDir) };
    const m = await createBackup(db, paths, 'manual', new Date('2026-10-15T09:30:00Z'));
    expect(m).toMatchObject({ id: '2026-10-15T09-30-00-000Z', reason: 'manual' });
    expect(listBackups(paths.backupsDir).map((b) => b.id)).toEqual([m.id]);

    // Nothing from data/secrets, no home credentials, no caches.
    const listing = tarList(join(m.path, 'bots.tar.gz')) + tarList(join(m.path, 'shared.tar.gz'));
    expect(listing).toContain('work/draft.md');
    expect(listing).not.toMatch(
      /secrets|auth\.json|credentials|mcp-token|mcp\.json|hosts\.yml|\.ssh|config\.toml/,
    );
    expect(listing).not.toMatch(/node_modules|\.cache/);
    const raw = execFileSync('sh', ['-c', `zcat ${m.path}/*.tar.gz | strings`], { encoding: 'utf8' });
    expect(raw).not.toContain('top-secret');
    expect(raw).not.toContain('secret .');

    // Wipe the DB and change the files.
    wipeAllData(db);
    expect(repos.bots.list({ includeArchived: true })).toEqual([]);
    const home = join(paths.botsDir, botId, 'home');
    put(join(home, 'work', 'draft.md'), 'draft v2');
    put(join(home, 'work', 'new.md'), 'created after the backup');
    rmSync(join(paths.sharedDir, 'knowledge'), { recursive: true });
    put(join(paths.botsDir, 'bot_gone', 'home', '.codex', 'auth.json'), 'orphan secret');
    closeDb(db);

    await restoreBackup(m.path, { dbPath, ...paths });
    db = openDb(dbPath);
    repos = createRepos(db);
    expect(dump(db)).toEqual(before);
    expect(repos.memories.search('sentences').map((x) => x.title)).toEqual(['Style']);
    const filesAfter = { bots: tree(paths.botsDir), shared: tree(paths.sharedDir) };
    // Caches are not restored; everything else (credentials included, kept in place) is identical.
    const noCache = (t: Record<string, string>) =>
      Object.fromEntries(Object.entries(t).filter(([p]) => !/node_modules|\.cache/.test(p)));
    expect(filesAfter.shared).toEqual(filesBefore.shared);
    expect(filesAfter.bots).toEqual(noCache(filesBefore.bots));
    expect(existsSync(join(paths.botsDir, 'bot_gone'))).toBe(false);
  });

  it('refuses an incomplete backup without touching anything', async () => {
    const m = await createBackup(db, paths, 'manual');
    rmSync(join(m.path, 'bots.tar.gz'));
    await expect(restoreBackup(m.path, { dbPath, ...paths })).rejects.toThrow(/not a complete backup/);
    expect(repos.bots.list()).toHaveLength(1);
    expect(listBackups(paths.backupsDir)).toEqual([]);
  });

  it('daily backup once per day, keeping the last 7 dailies and every manual one', async () => {
    let now = new Date('2026-10-01T08:00:00Z');
    const svc = new BackupService({ db, repos, paths, log: silent, now: () => now });
    await svc.backup('manual');
    for (let day = 0; day < 9; day++) {
      now = new Date(Date.UTC(2026, 9, 1 + day, 8));
      expect(await svc.daily()).not.toBeNull();
      now = new Date(Date.UTC(2026, 9, 1 + day, 20));
      expect(await svc.daily()).toBeNull();
    }
    const all = svc.list();
    expect(all.filter((b) => b.reason === 'daily').map((b) => b.createdAt.slice(0, 10))).toEqual(
      ['09', '08', '07', '06', '05', '04', '03'].map((d) => `2026-10-${d}`),
    );
    expect(all.filter((b) => b.reason === 'manual')).toHaveLength(1);
  });

  it('factory reset backs up first, then empties the DB, homes and share', async () => {
    const svc = new BackupService({ db, repos, paths, log: silent });
    const backup = await svc.factoryReset();
    expect(backup.reason).toBe('reset');
    expect(tarList(join(backup.path, 'bots.tar.gz'))).toContain('work/draft.md');
    const rows = dump(db);
    expect(rows.__drizzle_migrations!.length).toBeGreaterThan(0);
    for (const [name, r] of Object.entries(rows))
      if (name !== '__drizzle_migrations') expect(r, name).toEqual([]);
    expect(readdirSync(paths.botsDir)).toEqual([]);
    expect(readdirSync(paths.sharedDir).sort()).toEqual([...SHARED_LAYOUT].sort());
    // Engine logins are not touched.
    expect(existsSync(join(dir, 'data', 'secrets', 'codex', 'auth.json'))).toBe(true);
    // The DB still works.
    expect(repos.bots.create({ name: 'Again', engine: 'mock' }).name).toBe('Again');
  });

  it('routes: backup list, manual backup, RESET confirmation and Markdown exports', async () => {
    const svc = new BackupService({ db, repos, paths, log: silent });
    const app = await buildServer(loadConfig({ AGENTA_DB_PATH: ':memory:', LOG_LEVEL: 'silent' }), { repos });
    registerBackupRoutes(app, svc, paths.backupsDir);
    try {
      const made = await app.inject({ method: 'POST', url: '/api/backup' });
      expect(made.statusCode).toBe(200);
      const list = (await app.inject({ method: 'GET', url: '/api/backups' })).json();
      expect(list).toMatchObject({
        dir: paths.backupsDir,
        backups: [{ id: made.json().id, reason: 'manual' }],
      });

      const bad = await app.inject({ method: 'POST', url: '/api/reset', payload: { confirm: 'reset' } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.code).toBe('confirm_mismatch');
      expect(repos.bots.list()).toHaveLength(1);

      const thr = repos.threads.list()[0]!;
      const md = await app.inject({ method: 'GET', url: `/api/export/threads/${thr.id}` });
      expect(md.statusCode).toBe(200);
      expect(md.headers['content-type']).toBe('text/markdown; charset=utf-8');
      expect(md.headers['content-disposition']).toBe('attachment; filename="thread-writer.md"');
      expect(md.body).toContain('**You** · ');
      expect(md.body).toContain('hello');
      expect((await app.inject({ method: 'GET', url: '/api/export/threads/thr_nope' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/export/goals/goal_nope' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/export/lessons' })).body).toContain('## Testing');
      expect((await app.inject({ method: 'GET', url: '/api/export/decisions' })).body).toContain('_None._');

      const reset = await app.inject({ method: 'POST', url: '/api/reset', payload: { confirm: 'RESET' } });
      expect(reset.statusCode).toBe(200);
      expect(reset.json().backup.reason).toBe('reset');
      expect(repos.bots.list()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
