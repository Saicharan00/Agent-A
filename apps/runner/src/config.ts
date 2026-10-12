import { isAbsolute, join, resolve } from 'node:path';
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
  /** Bot homes (`<botsDir>/<botId>/home`) and the team share, bind-mounted into bot containers. */
  botsDir: z.string().min(1),
  sharedDir: z.string().min(1),
  /** Engine credentials (F06): <secretsDir>/codex/auth.json. Git-ignored, never mounted into containers. */
  secretsDir: z.string().min(1),
  /** .env.local, re-read for CLAUDE_CODE_OAUTH_TOKEN so a pasted token works without a restart. */
  envFile: z.string().min(1),
  /** Set AGENTA_DOCKER=0 to run without Docker (container routes then return docker_unavailable). */
  dockerEnabled: z.boolean(),
});
export type RunnerConfig = z.infer<typeof configSchema>;

function repoPath(root: string, p: string | undefined, fallback: string): string {
  const v = p?.trim();
  if (!v) return join(root, fallback);
  return isAbsolute(v) ? v : resolve(root, v);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const root = findRepoRoot();
  return configSchema.parse({
    host: env.AGENTA_RUNNER_HOST ?? DEFAULT_BIND_HOST,
    port: env.AGENTA_RUNNER_PORT ?? DEFAULT_PORTS.runner,
    webOrigin: env.AGENTA_WEB_ORIGIN ?? DEFAULT_WEB_ORIGIN,
    logLevel: env.LOG_LEVEL ?? 'info',
    engineOverride: env.AGENTA_ENGINE_OVERRIDE || undefined,
    dbPath: resolveDbPath(root, env),
    botsDir: repoPath(root, env.AGENTA_BOTS_DIR, 'data/bots'),
    sharedDir: repoPath(root, env.AGENTA_SHARED_DIR, 'data/shared'),
    secretsDir: repoPath(root, env.AGENTA_SECRETS_DIR, 'data/secrets'),
    envFile: join(root, '.env.local'),
    dockerEnabled: env.AGENTA_DOCKER !== '0',
  });
}
