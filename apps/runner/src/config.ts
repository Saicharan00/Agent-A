import { resolveDbPath } from '@agenta/db';
import { findRepoRoot } from '@agenta/shared/env';
import { DEFAULT_BIND_HOST, DEFAULT_PORTS, DEFAULT_WEB_ORIGIN } from '@agenta/shared';
import { z } from 'zod';

const configSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  webOrigin: z.string().url(),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  engineOverride: z.enum(['mock']).optional(),
  dbPath: z.string().min(1),
});
export type RunnerConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  return configSchema.parse({
    host: env.AGENTA_RUNNER_HOST ?? DEFAULT_BIND_HOST,
    port: env.AGENTA_RUNNER_PORT ?? DEFAULT_PORTS.runner,
    webOrigin: env.AGENTA_WEB_ORIGIN ?? DEFAULT_WEB_ORIGIN,
    logLevel: env.LOG_LEVEL ?? 'info',
    engineOverride: env.AGENTA_ENGINE_OVERRIDE || undefined,
    dbPath: resolveDbPath(findRepoRoot(), env),
  });
}
