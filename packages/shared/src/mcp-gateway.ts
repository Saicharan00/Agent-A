import { z } from 'zod';

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
  transport: z.enum(MCP_TRANSPORTS),
  command: z.string().trim().min(1).max(500).nullable(),
  args: z.array(z.string().max(2_000)).max(100),
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
  enabled: z.boolean(),
  defaultPolicy: z.enum(MCP_TOOL_POLICIES),
  /** Owner's per-tool overrides; tools not listed use their annotations / the default policy. */
  toolPolicies: policyMapSchema,
};

export const mcpServerCreateSchema = z
  .object({
    ...serverFields,
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
export type McpServerView = {
  id: string;
  name: string;
  slug: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  cwd: string | null;
  url: string | null;
  envRefs: Record<string, string>;
  headerRefs: Record<string, string>;
  enabled: boolean;
  defaultPolicy: McpToolPolicy;
  toolPolicies: Record<string, McpToolPolicy>;
  /** Cached tools with their effective server-level policy. */
  tools: (McpToolInfo & { policy: McpToolPolicy })[];
  /** .env.local variables the server references that are not set. */
  missingSecrets: string[];
  state: McpServerState;
  lastCheckAt: string | null;
  lastError: string | null;
  botIds: string[];
  createdAt: string;
};
