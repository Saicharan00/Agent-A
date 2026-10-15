// Restores a backup (F32). Usage: pnpm restore <backup folder>, e.g. pnpm restore data/backups/2026-10-15T09-30-00-000Z
// Stops the runner and the bot computers first, saves the current data as a "pre-restore" backup, then replaces the
// DB, the team share and the bot homes with the backup's. Engine logins (.env.local, data/secrets) are not touched.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { closeDb, openDb } from '../packages/db/src/index';
import { loadRootEnv } from '../packages/shared/src/env';
import { loadConfig } from '../apps/runner/src/config';
import { createBackup, readManifest, restoreBackup } from '../apps/runner/src/backup/archive';

async function runnerUp(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

/** The pid listening on `port` (from `ss -ltnp`), if this user can see it. */
function listenerPid(port: number): number | undefined {
  try {
    const out = execFileSync('ss', ['-Hltnp', `sport = :${port}`], { encoding: 'utf8' });
    const m = /pid=(\d+)/.exec(out);
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

async function stopRunner(port: number): Promise<void> {
  if (!(await runnerUp(port))) return;
  const pid = listenerPid(port);
  if (!pid)
    throw new Error(`The runner is running on port ${port}. Stop it (Ctrl+C in "pnpm dev") and try again.`);
  console.log(`Stopping the runner (pid ${pid})…`);
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 60; i++) {
    if (!(await runnerUp(port)) && !listenerPid(port)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('The runner did not stop within 15 s. Stop it by hand and try again.');
}

/** Bot computers write into their homes; stop them (only Agent A's, labelled agenta=1). Best effort. */
function stopBotComputers(): void {
  try {
    const ids = execFileSync('docker', ['ps', '-q', '--filter', 'label=agenta=1'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    if (ids.length) {
      console.log(`Stopping ${ids.length} bot computer(s)…`);
      execFileSync('docker', ['stop', '-t', '10', ...ids], { stdio: 'ignore' });
    }
  } catch {
    // no Docker: nothing is running
  }
}

async function main(): Promise<void> {
  const arg = process.argv.slice(2).find((a) => a !== '--');
  if (!arg) throw new Error('Usage: pnpm restore <backup folder>   (see Settings → Backups for the list)');
  const dir = resolve(process.env.INIT_CWD ?? process.cwd(), arg);
  const manifest = readManifest(dir);
  if (!manifest) throw new Error(`${dir} is not a complete backup (manifest.json or files missing)`);
  loadRootEnv();
  const config = loadConfig();

  await stopRunner(config.port);
  stopBotComputers();

  if (existsSync(config.dbPath)) {
    const db = openDb(config.dbPath, { migrate: false });
    try {
      const safety = await createBackup(
        db,
        { backupsDir: config.backupsDir, botsDir: config.botsDir, sharedDir: config.sharedDir },
        'pre-restore',
      );
      console.log(`Current data saved first: ${safety.path}`);
    } finally {
      closeDb(db);
    }
  }

  await restoreBackup(dir, { dbPath: config.dbPath, botsDir: config.botsDir, sharedDir: config.sharedDir });
  console.log(
    `Restored the backup from ${manifest.createdAt} (${manifest.reason}). Start the app again: pnpm dev`,
  );
}

main().catch((err: unknown) => {
  console.error(`restore: ${(err as Error).message}`);
  process.exit(1);
});
