import cors from '@fastify/cors';
import { apiError, type HealthResponse } from '@agenta/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import pkg from '../package.json' with { type: 'json' };
import type { RunnerConfig } from './config';

export async function buildServer(config: RunnerConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

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
    return { ok: true, version: pkg.version, uptime: process.uptime() };
  });

  return app;
}
