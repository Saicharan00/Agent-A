import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { type Db, backupDbTo, checkDbFile } from '@agenta/db';
import { type BackupManifest, type BackupReason, backupManifestSchema } from '@agenta/shared';

const run = promisify(execFile);

export const BACKUP_FILES = { db: 'agenta.db', shared: 'shared.tar.gz', bots: 'bots.tar.gz' } as const;
const MANIFEST = 'manifest.json';

/** Rebuildable caches inside bot homes and the share: never archived. */
export const CACHE_EXCLUDES = ['.cache', '.npm', 'node_modules', '.pnpm-store', '__pycache__'];

/**
 * Credentials that can sit in a bot home, relative to the home. Never archived, and kept in place across a restore.
 * The MCP token, mcp.json and Codex config.toml are re-issued before each run; Codex auth is synced from data/secrets.
 */
export const HOME_SECRETS = [
  '.codex/auth.json',
  '.codex/config.toml',
  '.claude/.credentials.json',
  '.agenta/mcp-token',
  '.agenta/mcp.json',
  '.config/gh/hosts.yml',
  '.git-credentials',
  '.ssh',
];

export type BackupPaths = { backupsDir: string; botsDir: string; sharedDir: string };

/** A sortable folder name from a time: 2026-10-15T09-30-00-000Z. */
export const backupId = (at: Date) => at.toISOString().replace(/[:.]/g, '-');

/** tar.gz of everything in `dir` except caches and home secrets. GNU tar patterns match at any depth. */
async function archiveDir(dir: string, out: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const excludes = [...CACHE_EXCLUDES, ...HOME_SECRETS].map((p) => `--exclude=${p}`);
  try {
    await run('tar', ['-czf', out, '--warning=no-file-changed', ...excludes, '-C', dir, '.']);
  } catch (err) {
    // Exit 1 = "some files changed while being read" (a bot was working): the archive is still usable.
    if ((err as { code?: unknown }).code !== 1) throw err;
  }
}

/**
 * data/backups/<id>/: agenta.db (VACUUM INTO), shared.tar.gz, bots.tar.gz and manifest.json.
 * Only the DB, the share and the bot homes are read, so data/secrets and .env.local never get in.
 */
export async function createBackup(
  db: Db,
  paths: BackupPaths,
  reason: BackupReason,
  now = new Date(),
): Promise<BackupManifest> {
  let id = backupId(now);
  for (let n = 2; existsSync(join(paths.backupsDir, id)); n++) id = `${backupId(now)}-${n}`;
  const dir = join(paths.backupsDir, id);
  // manifest.json is written last and marks the backup complete: a crash leaves a folder that is never listed.
  // (No folder rename at the end: on the Windows-backed data/ mount it fails while a scanner holds a new file.)
  mkdirSync(dir, { recursive: true });
  try {
    backupDbTo(db, join(dir, BACKUP_FILES.db));
    await archiveDir(paths.sharedDir, join(dir, BACKUP_FILES.shared));
    await archiveDir(paths.botsDir, join(dir, BACKUP_FILES.bots));
    const size = (f: string) => statSync(join(dir, f)).size;
    const manifest: BackupManifest = {
      id,
      createdAt: now.toISOString(),
      reason,
      files: { db: size(BACKUP_FILES.db), shared: size(BACKUP_FILES.shared), bots: size(BACKUP_FILES.bots) },
      path: dir,
    };
    writeFileSync(join(dir, MANIFEST), `${JSON.stringify({ ...manifest, path: undefined }, null, 2)}\n`);
    return manifest;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/** The manifest of a backup folder, or null when it is not a complete backup. */
export function readManifest(dir: string): BackupManifest | null {
  try {
    const m = backupManifestSchema.parse(JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')));
    if (!Object.values(BACKUP_FILES).every((f) => existsSync(join(dir, f)))) return null;
    return { ...m, path: resolve(dir) };
  } catch {
    return null;
  }
}

/** Complete backups, newest first. */
export function listBackups(backupsDir: string): BackupManifest[] {
  if (!existsSync(backupsDir)) return [];
  return readdirSync(backupsDir)
    .map((name) => readManifest(join(backupsDir, name)))
    .filter((m): m is BackupManifest => m !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/** Deletes daily backups beyond the newest `keep`. Returns the deleted ids. */
export function pruneDaily(backupsDir: string, keep: number): string[] {
  const old = listBackups(backupsDir)
    .filter((m) => m.reason === 'daily')
    .slice(keep);
  for (const m of old) rmSync(join(backupsDir, m.id), { recursive: true, force: true });
  return old.map((m) => m.id);
}

/** Deletes everything inside `dir` except the names in `keep` (the folder itself may be a bind mount). */
export function emptyDir(dir: string, keep: string[] = []): void {
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir)) {
    if (!keep.includes(entry)) rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

/**
 * Puts a backup back: the DB file, the share and the bot homes are replaced by the backup's.
 * The runner must be stopped (scripts/restore.ts does that). Credentials in bot homes (HOME_SECRETS) are kept for
 * bots that exist in the backup. Throws before touching anything when the backup is incomplete or its DB is damaged.
 */
export async function restoreBackup(
  backupDir: string,
  target: { dbPath: string; botsDir: string; sharedDir: string },
): Promise<BackupManifest> {
  const manifest = readManifest(backupDir);
  if (!manifest) throw new Error(`${backupDir} is not a complete backup (manifest or files missing)`);
  const backupDb = join(backupDir, BACKUP_FILES.db);
  const integrity = checkDbFile(backupDb);
  if (integrity !== 'ok') throw new Error(`The backup's database is damaged: ${integrity}`);

  // DB: drop the old WAL/SHM with the file so SQLite cannot replay stale pages onto the restored copy.
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${target.dbPath}${suffix}`, { force: true });
  copyFileSync(backupDb, target.dbPath);

  emptyDir(target.sharedDir);
  await run('tar', ['-xzf', join(backupDir, BACKUP_FILES.shared), '-C', target.sharedDir]);

  // Bot homes: move credentials aside (same filesystem, so rename works), replace the rest, then put them back.
  const keepName = `.restore-keep-${process.pid}`;
  const keepDir = join(target.botsDir, keepName);
  mkdirSync(keepDir, { recursive: true });
  for (const bot of readdirSync(target.botsDir)) {
    if (bot === keepName) continue;
    HOME_SECRETS.forEach((rel, i) => {
      const src = join(target.botsDir, bot, 'home', rel);
      if (!existsSync(src)) return;
      mkdirSync(join(keepDir, bot), { recursive: true });
      renameSync(src, join(keepDir, bot, String(i)));
    });
  }
  emptyDir(target.botsDir, [keepName]);
  await run('tar', ['-xzf', join(backupDir, BACKUP_FILES.bots), '-C', target.botsDir]);
  for (const bot of readdirSync(keepDir)) {
    const home = join(target.botsDir, bot, 'home');
    if (!existsSync(home)) continue; // the bot is not in the backup
    for (const i of readdirSync(join(keepDir, bot))) {
      const dest = join(home, HOME_SECRETS[Number(i)]!);
      mkdirSync(resolve(dest, '..'), { recursive: true });
      rmSync(dest, { recursive: true, force: true });
      renameSync(join(keepDir, bot, i), dest);
    }
  }
  rmSync(keepDir, { recursive: true, force: true });
  return manifest;
}
