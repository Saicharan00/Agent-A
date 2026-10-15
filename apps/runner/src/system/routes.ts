import {
  type AppSettings,
  type DoctorReport,
  type ImageBuildStatus,
  ONBOARDING_HELLO,
  type OnboardingTeamResponse,
  apiError,
  appSettingsUpdateSchema,
} from '@agenta/shared';
import type { FastifyInstance } from 'fastify';
import type { BotService } from '../bots/service';
import type { ThreadService } from '../threads/service';
import { type DoctorProbes, runDoctor } from './doctor';
import type { ImageBuilder } from './image-build';
import { readAppSettings, writeAppSettings } from './settings';

export type SystemRouteDeps = {
  probes: () => DoctorProbes;
  images: ImageBuilder;
  paths: AppSettings['paths'];
  bots?: BotService;
  threads?: ThreadService;
};

/**
 * F31: GET /api/doctor, GET/PUT /api/settings/app, GET/POST /api/image/build, POST /api/onboarding/team.
 */
export function registerSystemRoutes(app: FastifyInstance, deps: SystemRouteDeps): void {
  app.get('/api/doctor', async (): Promise<DoctorReport> => runDoctor(deps.probes()));

  app.get('/api/settings/app', async (): Promise<AppSettings> => ({
    ...readAppSettings(app.repos!),
    paths: deps.paths,
  }));

  app.put('/api/settings/app', async (req, reply): Promise<AppSettings | undefined> => {
    const body = appSettingsUpdateSchema.safeParse(req.body ?? {});
    if (!body.success) {
      const issue = body.error.issues[0];
      void reply.code(400).send(apiError('invalid_body', `${issue?.path.join('.')}: ${issue?.message}`));
      return;
    }
    writeAppSettings(app.repos!, body.data);
    return { ...readAppSettings(app.repos!), paths: deps.paths };
  });

  app.get('/api/image/build', async (): Promise<ImageBuildStatus> => deps.images.current());

  app.post('/api/image/build', async (_req, reply): Promise<ImageBuildStatus | undefined> => {
    if (!deps.images.start()) {
      void reply.code(409).send(apiError('build_running', 'An image build is already running'));
      return;
    }
    return deps.images.current();
  });

  // First-run wizard: create (or bring back) the Agent A team, then say hello to Agent A in its DM.
  app.post('/api/onboarding/team', async (_req, reply): Promise<OnboardingTeamResponse | undefined> => {
    if (!deps.bots || !deps.threads) {
      void reply.code(503).send(apiError('unavailable', 'Bots are not available on this runner'));
      return;
    }
    // BotError/ThreadError carry code + statusCode for the global error handler.
    const team = deps.bots.resetTeam();
    const hello = deps.threads.askLead(null, ONBOARDING_HELLO);
    return { created: team.created, leadRoomId: team.leadRoomId, leadThreadId: hello.message.threadId };
  });
}
