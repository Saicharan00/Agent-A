import cors from '@fastify/cors';
import { apiError, type HealthResponse } from '@agenta/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import pkg from '../package.json' with { type: 'json' };
import type { Repos } from '@agenta/db';
import type { RunnerConfig } from './config';
import type { ContainerManager } from './containers/manager';
import { registerComputerRoutes } from './containers/routes';

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
};

export async function buildServer(config: RunnerConfig, deps: ServerDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
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

  if (deps.containers) registerComputerRoutes(app, deps.containers);

  return app;
}
