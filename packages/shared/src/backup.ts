// Backup, restore, export and factory reset (F32).
import { z } from 'zod';

export const BACKUP_REASONS = ['manual', 'daily', 'reset', 'pre-restore'] as const;
export type BackupReason = (typeof BACKUP_REASONS)[number];

/** How many automatic daily backups are kept (manual and pre-reset ones are never pruned). */
export const DAILY_BACKUPS_KEPT = 7;

/** data/backups/<id>/manifest.json */
export const backupManifestSchema = z.object({
  /** The folder name: a UTC timestamp, e.g. 2026-10-15T09-30-00-000Z. */
  id: z.string(),
  createdAt: z.string(),
  reason: z.enum(BACKUP_REASONS),
  /** Size in bytes of each file in the folder. */
  files: z.object({ db: z.number(), shared: z.number(), bots: z.number() }),
  /** The absolute folder path inside the sandbox VM (filled in when listed). */
  path: z.string().default(''),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

export const backupListSchema = z.object({
  dir: z.string(),
  backups: z.array(backupManifestSchema),
});
export type BackupList = z.infer<typeof backupListSchema>;

/** The word the owner types to confirm a factory reset. */
export const FACTORY_RESET_WORD = 'RESET';

export const factoryResetRequestSchema = z.object({ confirm: z.literal(FACTORY_RESET_WORD) });
export const factoryResetResponseSchema = z.object({ backup: backupManifestSchema });
export type FactoryResetResponse = z.infer<typeof factoryResetResponseSchema>;
