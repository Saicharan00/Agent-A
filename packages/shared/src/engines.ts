import { z } from 'zod';

// Engine authentication status (F06): GET /api/settings/engines.

export const AUTH_ENGINES = ['claude', 'codex'] as const;
export type AuthEngine = (typeof AUTH_ENGINES)[number];

/** configured: credentials present and well-formed · missing: none found · invalid: present but unusable. */
export const ENGINE_AUTH_STATES = ['configured', 'missing', 'invalid'] as const;

/**
 * token: CLAUDE_CODE_OAUTH_TOKEN from .env.local, injected per exec ·
 * shared-file: data/secrets/codex/auth.json copied into each bot ·
 * per-bot: an engine login made inside a bot's own terminal · none.
 */
export const ENGINE_AUTH_MODES = ['token', 'shared-file', 'per-bot', 'none'] as const;

export const engineAuthStatusSchema = z.object({
  engine: z.enum(AUTH_ENGINES),
  state: z.enum(ENGINE_AUTH_STATES),
  mode: z.enum(ENGINE_AUTH_MODES),
  /** One-line, secret-free description of what was found. */
  detail: z.string(),
  /** Steps to fix or set up (empty when configured). */
  fix: z.array(z.string()),
  /** Bots that have their own in-container login (fallback mode). */
  perBotLogins: z.array(z.string()),
  /** Result of the CLI's own zero-cost status command, run inside a running bot computer. */
  cli: z.object({
    checked: z.boolean(),
    ok: z.boolean().optional(),
    botId: z.string().optional(),
    output: z.string().optional(),
    reason: z.string().optional(),
  }),
  checkedAt: z.string(),
});
export type EngineAuthStatus = z.infer<typeof engineAuthStatusSchema>;

export const engineSettingsResponseSchema = z.object({
  engines: z.array(engineAuthStatusSchema),
});
export type EngineSettingsResponse = z.infer<typeof engineSettingsResponseSchema>;
