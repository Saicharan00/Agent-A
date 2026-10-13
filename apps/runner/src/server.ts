import cors from '@fastify/cors';
import { apiError, type HealthResponse } from '@agenta/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import pkg from '../package.json' with { type: 'json' };
import type { Repos } from '@agenta/db';
import { registerBotRoutes } from './bots/routes';
import type { BotService } from './bots/service';
import type { RunnerConfig } from './config';
import type { ContainerManager } from './containers/manager';
import { registerComputerRoutes } from './containers/routes';
import type { EngineAuth } from './engines/auth';
import { registerEngineRoutes } from './engines/routes';
import type { LiveHub } from './live/hub';
import { registerLiveRoutes } from './live/routes';
import { registerEngineStateRoute, registerRunRoutes } from './runs/routes';
import type { RunService } from './runs/service';

declare module 'fastify' {
  interface FastifyInstance {
    repos: Repos | null;
  }
}

export type ServerDeps = {
  /** Data access for API routes (F12+). Null in tests that don't need a DB. */
  repos?: Repos;
  /** Bot container manager (F05). Without it, /api/health reports docker as disabled. */
  containers?: ContainerManager;
  /** Engine credentials (F06): GET /api/settings/engines. */
  engineAuth?: EngineAuth;
  /** Run orchestrator (F10): /api/runs routes. Needs `repos`. */
  runs?: RunService;
  /** Live event fan-out (F11): GET /ws. */
  live?: LiveHub;
  /** Bot management (F12): /api/bots CRUD, archive, restore, duplicate. */
  bots?: BotService;
};

/** Log paths that could carry engine credentials (defence in depth: nothing should log them). */
export const LOG_REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'env.CLAUDE_CODE_OAUTH_TOKEN',
  '*.env.CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  '*.CLAUDE_CODE_OAUTH_TOKEN',
];

export async function buildServer(config: RunnerConfig, deps: ServerDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: LOG_REDACT,
    },
  });

  app.decorate('repos', deps.repos ?? null);

  await app.register(cors, { origin: [config.webOrigin] });

  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send(apiError('not_found', `Route ${req.method} ${req.url} not found`));
  });

  app.setErrorHandler((err: { statusCode?: number; code?: string; message: string }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    void reply
      .code(status)
      .send(apiError(err.code ?? 'internal_error', status >= 500 ? 'Internal error' : err.message));
  });

  app.get('/api/health', async (): Promise<HealthResponse> => {
    const docker = deps.containers
      ? await deps.containers.dockerHealth()
      : { ok: false, error: 'Docker is disabled for this runner' };
    return { ok: true, version: pkg.version, uptime: process.uptime(), docker };
  });

  if (deps.bots) registerBotRoutes(app, deps.bots);
  if (deps.containers) registerComputerRoutes(app, deps.containers);
  if (deps.engineAuth) registerEngineRoutes(app, deps.engineAuth);
  if (deps.runs && deps.repos) registerRunRoutes(app, deps.runs);
  if (deps.repos) registerEngineStateRoute(app, config.engineOverride);
  if (deps.live) await registerLiveRoutes(app, deps.live, { webOrigin: config.webOrigin });

  return app;
}
