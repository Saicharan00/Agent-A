import { z } from 'zod';
import { looksLikeSecret } from './mcp-presets';

// MCP gateway (PLAN F35): external MCP servers the owner registers once; the runner connects to them on the bots'
// behalf and exposes the granted tools through the Platform MCP endpoint as `<server-slug>__<tool>`.

export const MCP_TRANSPORTS = ['stdio', 'http'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];
export const MCP_TOOL_POLICIES = ['allow', 'approval', 'deny'] as const;
export type McpToolPolicy = (typeof MCP_TOOL_POLICIES)[number];

/** Separates the server slug from the tool name in a gateway tool's name. */
export const GATEWAY_TOOL_SEPARATOR = '__';
/** Extra argument a bot adds when it retries an `approval` tool after the owner approved it. */
export const GATEWAY_APPROVAL_ARG = '_approval_id';
/** Every gateway call is cut off after this (PLAN F35: per-call timeout, default 60 s). */
export const GATEWAY_CALL_TIMEOUT_MS = 60_000;
/** A connected server nobody used for this long is shut down (lazy start on the next call). */
export const GATEWAY_IDLE_MS = 10 * 60_000;

/** Lower-case letters, digits and single dashes: safe in a tool name next to `__`. */
export const mcpSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lower-case letters, digits and single dashes');
/** Names of variables in .env.local, never values. */
const envNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Must be a variable name like MY_API_KEY');
const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'A domain like api.example.com');
const policyMapSchema = z.record(z.string().min(1).max(200), z.enum(MCP_TOOL_POLICIES));

/** One cached tool of a server, as listed by the server (annotations kept for the default policy). */
export const mcpToolInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z
    .object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional() })
    .passthrough()
    .optional(),
});
export type McpToolInfo = z.infer<typeof mcpToolInfoSchema>;

// No defaults here, so a PATCH never resets omitted fields; the create schema adds them.
const serverFields = {
  name: z.string().trim().min(1).max(80),
  slug: mcpSlugSchema,
  /** What it is for: shown in Settings and in the "Your tools" section of granted bots' instructions. */
  description: z.string().trim().max(500),
  transport: z.enum(MCP_TRANSPORTS),
  command: z.string().trim().min(1).max(500).nullable(),
  /** May reference .env.local variables as ${NAME} (e.g. a database URL with a password). */
  args: z.array(
    z
      .string()
      .max(2_000)
      .refine((a) => !looksLikeSecret(a), {
        message: 'Looks like a secret: put it in .env.local and write ${NAME} here instead',
      }),
  ),
  cwd: z.string().trim().min(1).max(500).nullable(),
  url: z.url({ protocol: /^https?$/ }).nullable(),
  /** Child env var name → .env.local variable name (stdio). */
  envRefs: z.record(envNameSchema, envNameSchema),
  /** HTTP header name → template naming .env.local variables, e.g. { "Authorization": "Bearer ${NOTION_TOKEN}" }. */
  headerRefs: z.record(
    z.string().trim().min(1).max(100),
    z
      .string()
      .max(500)
      .regex(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/, {
        message: 'Reference a .env.local variable as ${NAME}; never paste the secret itself',
      }),
  ),
  /** Domains the server calls (for the sandbox network policy); defaults are derived from the command / URL. */
  domains: z.array(hostnameSchema).max(50),
  enabled: z.boolean(),
  defaultPolicy: z.enum(MCP_TOOL_POLICIES),
  /** Owner's per-tool overrides; tools not listed use their annotations / the default policy. */
  toolPolicies: policyMapSchema,
};

export const mcpServerCreateSchema = z
  .object({
    ...serverFields,
    description: serverFields.description.default(''),
    domains: serverFields.domains.default([]),
    command: serverFields.command.default(null),
    args: serverFields.args.default([]),
    cwd: serverFields.cwd.default(null),
    url: serverFields.url.default(null),
    envRefs: serverFields.envRefs.default({}),
    headerRefs: serverFields.headerRefs.default({}),
    enabled: serverFields.enabled.default(true),
    defaultPolicy: serverFields.defaultPolicy.default('approval'),
    toolPolicies: serverFields.toolPolicies.default({}),
  })
  .refine((s) => (s.transport === 'stdio' ? !!s.command : !!s.url), {
    message: 'A stdio server needs a command; an http server needs a url',
    path: ['command'],
  });
export type McpServerCreateInput = z.input<typeof mcpServerCreateSchema>;
export const mcpServerUpdateSchema = z.object(serverFields).partial();
export type McpServerUpdateInput = z.input<typeof mcpServerUpdateSchema>;
/** POST /api/mcp-servers: a server, optionally granted at once to every specialist (non-lead) or every bot. */
export const mcpServerCreateRequestSchema = z.object({
  server: mcpServerCreateSchema,
  grantTo: z.enum(['specialists', 'all']).optional(),
});

/** A bot's access to one server: `*` = every tool, else the allowlist; per-tool policy overrides for this bot. */
export const botMcpAccessSchema = z.object({
  serverId: z.string().min(1),
  tools: z.union([z.literal('*'), z.array(z.string().min(1).max(200)).max(500)]).default('*'),
  toolPolicies: policyMapSchema.default({}),
});
export type BotMcpAccessInput = z.input<typeof botMcpAccessSchema>;
export const botMcpAccessPutSchema = z.object({ access: z.array(botMcpAccessSchema).max(100) });

export const MCP_SERVER_STATES = ['connected', 'idle', 'error'] as const;
export type McpServerState = (typeof MCP_SERVER_STATES)[number];

/** A server as the API returns it. Secret values are never included: only which referenced variables are set. */
export const mcpServerViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  /** Domains to allow in the sandbox network policy (the saved list, or the defaults for its command / URL). */
  domains: z.array(z.string()),
  /** The owner's command to allow them (`sbx policy allow network …`); null when there is nothing to allow. */
  networkCommand: z.string().nullable(),
  transport: z.enum(MCP_TRANSPORTS),
  command: z.string().nullable(),
  args: z.array(z.string()),
  cwd: z.string().nullable(),
  url: z.string().nullable(),
  envRefs: z.record(z.string(), z.string()),
  headerRefs: z.record(z.string(), z.string()),
  enabled: z.boolean(),
  defaultPolicy: z.enum(MCP_TOOL_POLICIES),
  toolPolicies: z.record(z.string(), z.enum(MCP_TOOL_POLICIES)),
  /** Cached tools with their effective server-level policy. */
  tools: z.array(mcpToolInfoSchema.extend({ policy: z.enum(MCP_TOOL_POLICIES) })),
  /** .env.local variables the server references that are not set. */
  missingSecrets: z.array(z.string()),
  state: z.enum(MCP_SERVER_STATES),
  lastCheckAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** Remote servers only: `signed-in` once the owner completed the OAuth sign-in (tokens kept in data/secrets). */
  oauth: z.enum(['none', 'signed-in']),
  botIds: z.array(z.string()),
  createdAt: z.string(),
});
export type McpServerView = z.infer<typeof mcpServerViewSchema>;

/** One of a bot's grants as the API returns it. */
export const botMcpAccessViewSchema = z.object({
  botId: z.string(),
  serverId: z.string(),
  toolAllowlist: z.union([z.literal('*'), z.array(z.string())]),
  toolPolicies: z.record(z.string(), z.enum(MCP_TOOL_POLICIES)),
});
export type BotMcpAccessView = z.infer<typeof botMcpAccessViewSchema>;

/**
 * How pages a bot fetches or browses from the sandbox get through the network policy (PLAN F35 web research):
 * `per-domain` (safer: the owner allows each domain as bots ask) or `broad` (one allowance for all web traffic).
 */
export const WEB_ACCESS_MODES = ['per-domain', 'broad'] as const;
export type WebAccessMode = (typeof WEB_ACCESS_MODES)[number];
export const researchSettingsSchema = z.object({ webAccess: z.enum(WEB_ACCESS_MODES) });
export const researchSettingsViewSchema = researchSettingsSchema.extend({
  /** The owner's matching `sbx` command (also written to HUMAN_TODO.md when saved); null outside a sandbox. */
  command: z.string().nullable(),
});
export type ResearchSettings = z.infer<typeof researchSettingsViewSchema>;

/** POST /api/mcp-servers/:id/oauth: where to send the owner to sign in, or `authorized` when already signed in. */
export const mcpOAuthStartSchema = z.object({
  status: z.enum(['redirect', 'authorized']),
  authorizationUrl: z.string().nullable(),
});
export type McpOAuthStart = z.infer<typeof mcpOAuthStartSchema>;
