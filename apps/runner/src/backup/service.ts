import { type Db, type Repos, wipeAllData } from '@agenta/db';
import { type BackupManifest, type BackupReason, DAILY_BACKUPS_KEPT } from '@agenta/shared';
import type { ContainerManager } from '../containers/manager';
import { ensureSharedLayout } from '../containers/home';
import type { GatewayService } from '../gateway/service';
import type { RunService } from '../runs/service';
import { readAppSettings } from '../system/settings';
import { type BackupPaths, createBackup, emptyDir, listBackups, pruneDaily } from './archive';

type Log = {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
};

export type BackupServiceOptions = {
  db: Db;
  repos: Repos;
  paths: BackupPaths;
  log: Log;
  runs?: RunService;
  containers?: ContainerManager;
  gateway?: GatewayService;
  now?: () => Date;
};

/** The calendar day of `at` in `timeZone` (YYYY-MM-DD). */
const dayIn = (at: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(at);

/** F32: manual and daily backups, the backup list, and factory reset. */
export class BackupService {
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;

  constructor(private readonly opts: BackupServiceOptions) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** One backup at a time: concurrent calls queue behind each other. */
  backup(reason: BackupReason): Promise<BackupManifest> {
    const next = this.chain.then(async () => {
      const m = await createBackup(this.opts.db, this.opts.paths, reason, this.now());
      this.opts.log.info({ id: m.id, reason }, 'backup written');
      return m;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  list(): BackupManifest[] {
    return listBackups(this.opts.paths.backupsDir);
  }

  /**
   * The first launch of the day (in the app's time zone) makes a daily backup; only the newest 7 dailies are kept.
   * Returns the new backup, or null when today's already exists.
   */
  async daily(): Promise<BackupManifest | null> {
    const tz = readAppSettings(this.opts.repos).timezone;
    const today = dayIn(this.now(), tz);
    if (this.list().some((b) => b.reason === 'daily' && dayIn(new Date(b.createdAt), tz) === today))
      return null;
    const m = await this.backup('daily');
    const pruned = pruneDaily(this.opts.paths.backupsDir, DAILY_BACKUPS_KEPT);
    if (pruned.length) this.opts.log.info({ pruned }, 'old daily backups deleted');
    return m;
  }

  /** Daily backup now, then hourly checks so a runner left on overnight still backs up each day. */
  start(): void {
    const tick = () =>
      void this.daily().catch((err: unknown) =>
        this.opts.log.error({ err: (err as Error).message }, 'daily backup failed'),
      );
    tick();
    this.timer = setInterval(tick, 60 * 60_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /**
   * Factory reset: backs up first, then cancels runs, removes bot computers, deletes every row and empties the share
   * and bot homes. Engine logins (data/secrets, .env.local) are kept. Afterwards Home shows the first-run wizard.
   */
  async factoryReset(): Promise<BackupManifest> {
    const backup = await this.backup('reset');
    const { repos, runs, containers, gateway, log } = this.opts;
    // No new runs start while the data goes; queued ones are cancelled and running engines stopped and recorded.
    runs?.stop();
    try {
      const active = repos.runs.list({ status: ['queued', 'running'], limit: 1000 });
      await Promise.all(active.map((r) => runs?.cancel(r.id).catch(() => undefined)));
      await runs?.shutdown();
      for (const bot of repos.bots.list({ includeArchived: true })) {
        try {
          await containers?.destroy(bot.id);
        } catch (err) {
          log.warn(
            { botId: bot.id, err: (err as Error).message },
            'could not remove bot computer during reset',
          );
        }
      }
      await gateway?.close();
      wipeAllData(this.opts.db);
      emptyDir(this.opts.paths.botsDir);
      emptyDir(this.opts.paths.sharedDir);
      ensureSharedLayout(this.opts.paths.sharedDir);
    } finally {
      runs?.start();
    }
    log.info({ backup: backup.id }, 'factory reset done');
    return backup;
  }
}
