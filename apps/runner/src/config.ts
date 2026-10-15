import { isAbsolute, join, resolve } from 'node:path';
import { resolveDbPath } from '@agenta/db';
import { findRepoRoot } from '@agenta/shared/env';
import { DEFAULT_BIND_HOST, DEFAULT_PORTS, DEFAULT_WEB_ORIGIN } from '@agenta/shared';
import { z } from 'zod';

const configSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  /** Platform MCP server (F17): 127.0.0.1 plus the bot network gateway. 0 picks a free port (tests). */
  mcpPort: z.coerce.number().int().min(0).max(65535),
  webOrigin: z.string().url(),
  /** Extra host names the API answers to besides loopback and the web origin's (AGENTA_ALLOWED_HOSTS, comma list). */
  allowedHosts: z.array(z.string().min(1)),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  engineOverride: z.enum(['mock']).optional(),
  dbPath: z.string().min(1),
  /** Bot homes (`<botsDir>/<botId>/home`) and the team share, bind-mounted into bot containers. */
  botsDir: z.string().min(1),
  sharedDir: z.string().min(1),
  /** The Agent A team template (F21): team.json, bots/<slug>.md, skills/<name>/SKILL.md. */
  teamDir: z.string().min(1),
  /** Engine credentials (F06): <secretsDir>/codex/auth.json. Git-ignored, never mounted into containers. */
  secretsDir: z.string().min(1),
  /** Backups (F32): <backupsDir>/<timestamp>/. Never inside botsDir/sharedDir, which backups archive. */
  backupsDir: z.string().min(1),
  /** .env.local, re-read for CLAUDE_CODE_OAUTH_TOKEN so a pasted token works without a restart. */
  envFile: z.string().min(1),
  /** HUMAN_TODO.md, where owner actions (network allow commands, F35) are appended. AGENTA_HUMAN_TODO overrides. */
  humanTodoFile: z.string().min(1),
  /** This Docker Sandbox's name for `sbx` commands shown to the owner (SANDBOX_NAME in the VM). */
  sandboxName: z.string().min(1),
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
    mcpPort: env.AGENTA_MCP_PORT ?? DEFAULT_PORTS.mcp,
    webOrigin: env.AGENTA_WEB_ORIGIN ?? DEFAULT_WEB_ORIGIN,
    allowedHosts: (env.AGENTA_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    logLevel: env.LOG_LEVEL ?? 'info',
    engineOverride: env.AGENTA_ENGINE_OVERRIDE || undefined,
    dbPath: resolveDbPath(root, env),
    botsDir: repoPath(root, env.AGENTA_BOTS_DIR, 'data/bots'),
    sharedDir: repoPath(root, env.AGENTA_SHARED_DIR, 'data/shared'),
    teamDir: join(root, 'templates/team'),
    secretsDir: repoPath(root, env.AGENTA_SECRETS_DIR, 'data/secrets'),
    backupsDir: repoPath(root, env.AGENTA_BACKUPS_DIR, 'data/backups'),
    envFile: join(root, '.env.local'),
    humanTodoFile: repoPath(root, env.AGENTA_HUMAN_TODO, 'HUMAN_TODO.md'),
    sandboxName: env.SANDBOX_NAME || 'agent-a',
    dockerEnabled: env.AGENTA_DOCKER !== '0',
  });
}
