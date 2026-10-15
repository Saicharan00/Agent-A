import type { Repos } from '@agenta/db';
import {
  type BackupList,
  type BackupManifest,
  FACTORY_RESET_WORD,
  type FactoryResetResponse,
  apiError,
  factoryResetRequestSchema,
} from '@agenta/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type MarkdownExport, exportDecisions, exportGoal, exportLessons, exportThread } from './export';
import type { BackupService } from './service';

function sendMarkdown(reply: FastifyReply, out: MarkdownExport | undefined, what: string) {
  if (!out) return reply.code(404).send(apiError('not_found', `${what} not found`));
  return reply
    .header('content-type', 'text/markdown; charset=utf-8')
    .header('content-disposition', `attachment; filename="${out.filename}"`)
    .send(out.markdown);
}

/**
 * F32: GET /api/backups, POST /api/backup, POST /api/reset (body { confirm: "RESET" }),
 * GET /api/export/{threads/:id, goals/:id, decisions, lessons} as Markdown downloads.
 */
export function registerBackupRoutes(app: FastifyInstance, backups: BackupService, backupsDir: string): void {
  const repos = (): Repos => app.repos!;
  const now = () => new Date().toISOString();

  app.get('/api/backups', async (): Promise<BackupList> => ({ dir: backupsDir, backups: backups.list() }));

  app.post('/api/backup', async (): Promise<BackupManifest> => backups.backup('manual'));

  app.post('/api/reset', async (req, reply): Promise<FactoryResetResponse | undefined> => {
    if (!factoryResetRequestSchema.safeParse(req.body ?? {}).success) {
      void reply.code(400).send(apiError('confirm_mismatch', `Type ${FACTORY_RESET_WORD} to confirm`));
      return;
    }
    return { backup: await backups.factoryReset() };
  });

  app.get<{ Params: { id: string } }>('/api/export/threads/:id', async (req, reply) =>
    sendMarkdown(reply, exportThread(repos(), req.params.id, now()), 'Thread'),
  );
  app.get<{ Params: { id: string } }>('/api/export/goals/:id', async (req, reply) =>
    sendMarkdown(reply, exportGoal(repos(), req.params.id, now()), 'Goal'),
  );
  app.get('/api/export/decisions', async (_req, reply) =>
    sendMarkdown(reply, exportDecisions(repos(), now()), ''),
  );
  app.get('/api/export/lessons', async (_req, reply) =>
    sendMarkdown(reply, exportLessons(repos(), now()), ''),
  );
}
