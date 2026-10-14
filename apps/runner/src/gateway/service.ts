import { createHash } from 'node:crypto';
import type { Bot, BotMcpAccess, McpServer, Repos } from '@agenta/db';
import {
  GATEWAY_APPROVAL_ARG,
  GATEWAY_TOOL_SEPARATOR,
  type BotMcpAccessInput,
  type McpServerCreateInput,
  type McpServerUpdateInput,
  type McpServerView,
  type McpToolInfo,
  type McpToolPolicy,
  mcpServerCreateSchema,
} from '@agenta/shared';
import type { ApprovalService } from '../approvals/service';
import { type SecretSource, redactSecrets } from '../engines/secrets';
import { type ConnectSpec, McpConnections, stdioEnv } from './connections';

type Log = {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
};

export class GatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

/** A gateway tool as a bot sees it in tools/list. */
export type GatewayTool = { name: string; description: string; inputSchema: Record<string, unknown> };
/** A gateway call's answer to the bot: text only, secrets redacted. */
export type GatewayResult = { text: string; isError: boolean };

export type GatewayServiceOptions = {
  repos: Repos;
  secrets: SecretSource;
  approvals: Pick<ApprovalService, 'request' | 'get'>;
  log: Log;
  connections?: McpConnections;
};

const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const MAX_RESULT_CHARS = 50_000;

/** The default policy of a tool the owner did not set: read-only tools run, others ask (or the server's default). */
export function annotationPolicy(tool: McpToolInfo | undefined, serverDefault: McpToolPolicy): McpToolPolicy {
  if (tool?.annotations?.readOnlyHint === true) return 'allow';
  if (tool?.annotations?.destructiveHint === true && serverDefault === 'allow') return 'approval';
  return serverDefault;
}

/** JSON with sorted keys, so the same arguments always give the same fingerprint. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
export const callFingerprint = (args: Record<string, unknown>) =>
  createHash('sha256').update(canonical(args)).digest('hex').slice(0, 16);

/** The .env.local variables a server references (env values and ${NAME} in header templates). */
export function secretNames(server: Pick<McpServer, 'envRefs' | 'headerRefs'>): string[] {
  const names = new Set(Object.values(server.envRefs));
  for (const t of Object.values(server.headerRefs)) for (const m of t.matchAll(VAR_REF)) names.add(m[1]!);
  return [...names];
}

/**
 * The MCP gateway (PLAN F35): the owner registers external MCP servers; the runner connects to them on the bots'
 * behalf and exposes each granted tool as `<server-slug>__<tool>` on the Platform MCP endpoint. One place for
 * per-bot access, policies (allow / approval / deny), logging and secrets: keys never enter bot containers.
 */
export class GatewayService {
  readonly connections: McpConnections;
  // shortcut: approvals already used for a call are remembered in memory only, so after a runner restart an
  // approved call could be replayed once with the same arguments; persist if that ever matters.
  private readonly usedApprovals = new Set<string>();

  constructor(private readonly opts: GatewayServiceOptions) {
    this.connections =
      opts.connections ??
      new McpConnections({ log: opts.log, onToolsChanged: (id) => void this.refreshTools(id) });
  }

  // ---- registry ----

  list(): McpServerView[] {
    return this.opts.repos.mcpServers.list().map((s) => this.view(s));
  }

  get(id: string): McpServerView {
    return this.view(this.server(id));
  }

  create(input: McpServerCreateInput): McpServerView {
    const data = mcpServerCreateSchema.parse(input);
    if (this.opts.repos.mcpServers.getBySlug(data.slug))
      throw new GatewayError('slug_taken', `A server with slug "${data.slug}" already exists`, 409);
    const s = this.opts.repos.mcpServers.create(data);
    this.opts.log.info({ serverId: s.id, slug: s.slug, transport: s.transport }, 'MCP server added');
    return this.view(s);
  }

  async update(id: string, input: McpServerUpdateInput): Promise<McpServerView> {
    const before = this.server(id);
    if (input.slug && input.slug !== before.slug && this.opts.repos.mcpServers.getBySlug(input.slug))
      throw new GatewayError('slug_taken', `A server with slug "${input.slug}" already exists`, 409);
    const s = this.opts.repos.mcpServers.update(id, input)!;
    if (s.transport === 'stdio' ? !s.command : !s.url)
      throw new GatewayError('invalid_body', 'A stdio server needs a command; an http server needs a url');
    // Connection settings may have changed: reconnect on next use.
    await this.connections.close(id);
    return this.view(s);
  }

  async remove(id: string): Promise<void> {
    this.server(id);
    await this.connections.close(id);
    this.opts.repos.mcpServers.delete(id);
  }

  /** "Test connection": (re)connects, lists the tools with descriptions and caches them. */
  async test(id: string): Promise<McpServerView> {
    const s = this.server(id);
    await this.connections.close(id);
    try {
      const tools = await this.connections.listTools(id, () => this.spec(s));
      return this.view(this.opts.repos.mcpServers.recordCheck(id, { tools, error: null })!);
    } catch (err) {
      const error = this.explain(s, err);
      this.opts.log.warn({ serverId: id, error }, 'MCP server check failed');
      return this.view(this.opts.repos.mcpServers.recordCheck(id, { error })!);
    }
  }

  // ---- per-bot access ----

  accessFor(botId: string): BotMcpAccess[] {
    return this.opts.repos.mcpServers.accessForBot(botId);
  }

  setAccess(botId: string, access: BotMcpAccessInput[]): BotMcpAccess[] {
    if (!this.opts.repos.bots.get(botId)) throw new GatewayError('not_found', `Bot ${botId} not found`, 404);
    for (const a of access) this.server(a.serverId);
    return this.opts.repos.mcpServers.setAccess(botId, access);
  }

  // ---- what bots see and call ----

  /** The gateway tools this bot may see: enabled, granted servers; allowlisted, non-denied tools. */
  async toolsFor(bot: Bot): Promise<GatewayTool[]> {
    const out: GatewayTool[] = [];
    for (const { server, access } of this.grants(bot.id)) {
      // Never listed yet: start it now (lazy start); a failure only hides this server's tools.
      const tools = server.toolsCache ?? (await this.refreshTools(server.id));
      if (!tools) continue;
      // Policies read the cache, so use the freshly listed tools' annotations too.
      server.toolsCache = tools;
      for (const tool of tools) {
        if (!this.allowed(access, tool.name)) continue;
        const policy = this.policy(server, access, tool.name);
        if (policy === 'deny') continue;
        out.push(this.exposed(server, tool, policy));
      }
    }
    return out;
  }

  /** True when `name` looks like `<slug>__<tool>` of a registered server (the Platform MCP server routes on it). */
  isGatewayTool(name: string): boolean {
    const slug = name.split(GATEWAY_TOOL_SEPARATOR)[0];
    return name.includes(GATEWAY_TOOL_SEPARATOR) && !!slug && !!this.opts.repos.mcpServers.getBySlug(slug);
  }

  /** Calls a gateway tool as `bot`, enforcing access and policy. Refusals throw GatewayError. */
  async call(bot: Bot, name: string, rawArgs: unknown, runId: string | null = null): Promise<GatewayResult> {
    const sep = name.indexOf(GATEWAY_TOOL_SEPARATOR);
    const slug = name.slice(0, sep);
    const toolName = name.slice(sep + GATEWAY_TOOL_SEPARATOR.length);
    const server = sep > 0 ? this.opts.repos.mcpServers.getBySlug(slug) : undefined;
    // Policies come from the listed tools' annotations: list once first (lazy start) if never listed.
    if (server?.enabled && !server.toolsCache)
      server.toolsCache = (await this.refreshTools(server.id)) ?? null;
    const access = server && this.opts.repos.mcpServers.getAccess(bot.id, server.id);
    const policy = server && access && this.policy(server, access, toolName);
    if (
      !server ||
      !server.enabled ||
      !access ||
      !this.allowed(access, toolName) ||
      policy === 'deny' ||
      !policy
    ) {
      this.opts.log.warn({ botId: bot.id, tool: name }, 'gateway call refused: no access');
      throw new GatewayError('no_access', `You do not have access to the tool ${name}`, 403);
    }
    const args = { ...((rawArgs ?? {}) as Record<string, unknown>) };
    const approvalId = args[GATEWAY_APPROVAL_ARG];
    delete args[GATEWAY_APPROVAL_ARG];
    const fingerprint = callFingerprint(args);
    const action = `Use ${server.slug}${GATEWAY_TOOL_SEPARATOR}${toolName}`;
    const secrets = this.secretValues(server);

    if (policy === 'approval') {
      if (typeof approvalId !== 'string' || !approvalId) {
        const tool = server.toolsCache?.find((t) => t.name === toolName);
        const shownArgs = redactSecrets(JSON.stringify(args, null, 2), secrets).slice(0, 4_000);
        const a = this.opts.approvals.request(
          bot,
          {
            action,
            details:
              `${bot.name} wants to call **${toolName}** on the MCP server **${server.name}**.\n\n` +
              `Arguments:\n\n\`\`\`json\n${shownArgs}\n\`\`\`\n\nCall fingerprint: \`${fingerprint}\``,
            risk: tool?.annotations?.destructiveHint ? 'high' : 'medium',
          },
          runId,
        );
        this.opts.log.info({ botId: bot.id, tool: name, approvalId: a.id }, 'gateway call needs approval');
        return {
          isError: false,
          text: JSON.stringify(
            {
              status: 'pending',
              approval_id: a.id,
              message:
                'This tool needs the owner’s approval. Call check_approval with this approval_id until it is ' +
                `approved, then call ${name} again with the same arguments plus "${GATEWAY_APPROVAL_ARG}": "${a.id}".`,
            },
            null,
            2,
          ),
        };
      }
      this.checkApproval(bot, approvalId, action, fingerprint);
    }

    const started = Date.now();
    try {
      const result = await this.connections.callTool(server.id, () => this.spec(server), toolName, args);
      const text = redactSecrets(resultText(result.content), secrets);
      this.opts.log.info(
        {
          botId: bot.id,
          server: server.slug,
          tool: toolName,
          isError: !!result.isError,
          ms: Date.now() - started,
        },
        'gateway call',
      );
      if (typeof approvalId === 'string') this.usedApprovals.add(approvalId);
      return { text: clip(text), isError: !!result.isError };
    } catch (err) {
      const message = this.explain(server, err);
      this.opts.log.warn(
        { botId: bot.id, server: server.slug, tool: toolName, error: message },
        'gateway call failed',
      );
      this.opts.repos.mcpServers.recordCheck(server.id, { error: message });
      return { text: `The MCP server ${server.name} failed: ${message}`, isError: true };
    }
  }

  async close(): Promise<void> {
    await this.connections.closeAll();
  }

  // ---- internals ----

  private checkApproval(bot: Bot, approvalId: string, action: string, fingerprint: string): void {
    let a: ReturnType<ApprovalService['get']>;
    try {
      a = this.opts.approvals.get(approvalId);
    } catch {
      throw new GatewayError('approval_not_found', `No approval ${approvalId}`);
    }
    if (a.botId !== bot.id || a.action !== action || !a.detailsMd.includes(`\`${fingerprint}\``))
      throw new GatewayError(
        'approval_mismatch',
        `Approval ${approvalId} was not given for this call; call the tool without ${GATEWAY_APPROVAL_ARG} to ask again`,
      );
    if (a.status === 'pending')
      throw new GatewayError(
        'approval_pending',
        `Approval ${approvalId} is still pending; wait and check again`,
      );
    if (a.status !== 'approved')
      throw new GatewayError('approval_' + a.status, `Approval ${approvalId} was ${a.status}; do not retry`);
    if (this.usedApprovals.has(approvalId))
      throw new GatewayError('approval_used', `Approval ${approvalId} was already used; ask again`);
  }

  private grants(botId: string): { server: McpServer; access: BotMcpAccess }[] {
    const { mcpServers } = this.opts.repos;
    return mcpServers
      .accessForBot(botId)
      .map((access) => ({ server: mcpServers.get(access.serverId)!, access }))
      .filter((g) => g.server?.enabled);
  }

  private allowed(access: BotMcpAccess, tool: string): boolean {
    return access.toolAllowlist === '*' || access.toolAllowlist.includes(tool);
  }

  /** Bot override, then the owner's per-tool setting, then the tool's annotations / server default. */
  policy(server: McpServer, access: BotMcpAccess | undefined, tool: string): McpToolPolicy {
    return (
      access?.toolPolicies[tool] ??
      server.toolPolicies[tool] ??
      annotationPolicy(
        server.toolsCache?.find((t) => t.name === tool),
        server.defaultPolicy,
      )
    );
  }

  private exposed(server: McpServer, tool: McpToolInfo, policy: McpToolPolicy): GatewayTool {
    const name = `${server.slug}${GATEWAY_TOOL_SEPARATOR}${tool.name}`;
    const schema: Record<string, unknown> = { type: 'object', ...tool.inputSchema };
    let description = `[${server.name}] ${tool.description ?? tool.name}`;
    if (policy === 'approval') {
      const props = (schema.properties ?? {}) as Record<string, unknown>;
      schema.properties = {
        ...props,
        [GATEWAY_APPROVAL_ARG]: {
          type: 'string',
          description: 'Approval id, only when retrying after the owner approved this call',
        },
      };
      description +=
        ' (Needs the owner’s approval: the first call returns an approval_id; once check_approval says ' +
        `approved, call again with the same arguments plus ${GATEWAY_APPROVAL_ARG}.)`;
    }
    return { name, description, inputSchema: schema };
  }

  private async refreshTools(serverId: string): Promise<McpToolInfo[] | undefined> {
    const s = this.opts.repos.mcpServers.get(serverId);
    if (!s) return undefined;
    try {
      const tools = await this.connections.listTools(serverId, () => this.spec(s));
      this.opts.repos.mcpServers.recordCheck(serverId, { tools, error: null });
      return tools;
    } catch (err) {
      const error = this.explain(s, err);
      this.opts.log.warn({ serverId, error }, 'MCP server tools refresh failed');
      this.opts.repos.mcpServers.recordCheck(serverId, { error });
      return undefined;
    }
  }

  /** Connection settings with secret values from .env.local, read now (never stored). */
  private spec(s: McpServer): ConnectSpec {
    const missing = secretNames(s).filter((n) => !this.opts.secrets.get(n));
    if (missing.length)
      throw new GatewayError('missing_secret', `Set ${missing.join(', ')} in .env.local, then test again`);
    const value = (n: string) => this.opts.secrets.get(n)!;
    if (s.transport === 'stdio') {
      const env = Object.fromEntries(Object.entries(s.envRefs).map(([k, ref]) => [k, value(ref)]));
      return { transport: 'stdio', command: s.command!, args: s.args, cwd: s.cwd, env: stdioEnv(env) };
    }
    const headers = Object.fromEntries(
      Object.entries(s.headerRefs).map(([k, t]) => [k, t.replace(VAR_REF, (_, n: string) => value(n))]),
    );
    return { transport: 'http', url: s.url!, headers };
  }

  private secretValues(s: McpServer): string[] {
    return secretNames(s)
      .map((n) => this.opts.secrets.get(n))
      .filter((v): v is string => !!v);
  }

  /** A readable, redacted error; a sandbox network-policy block says which domain to allow. */
  private explain(s: McpServer, err: unknown): string {
    const msg = redactSecrets((err as Error)?.message ?? String(err), this.secretValues(s)).slice(0, 2_000);
    if (/Blocked by|Approval required|network policy/i.test(msg) || /\b403\b.*proxy/i.test(msg)) {
      const host = s.url ? new URL(s.url).hostname : '<domain>';
      return (
        `Blocked by the sandbox network policy. Allow the server's domain on the host: ` +
        `sbx policy allow network --sandbox agent-a ${host}\n${msg}`
      );
    }
    return msg;
  }

  private server(id: string): McpServer {
    const s = this.opts.repos.mcpServers.get(id);
    if (!s) throw new GatewayError('not_found', `MCP server ${id} not found`, 404);
    return s;
  }

  private view(s: McpServer): McpServerView {
    const { mcpServers } = this.opts.repos;
    return {
      id: s.id,
      name: s.name,
      slug: s.slug,
      transport: s.transport,
      command: s.command,
      args: s.args,
      cwd: s.cwd,
      url: s.url,
      envRefs: s.envRefs,
      headerRefs: s.headerRefs,
      enabled: s.enabled,
      defaultPolicy: s.defaultPolicy,
      toolPolicies: s.toolPolicies,
      tools: (s.toolsCache ?? []).map((t) => ({ ...t, policy: this.policy(s, undefined, t.name) })),
      missingSecrets: secretNames(s).filter((n) => !this.opts.secrets.get(n)),
      state: this.connections.isConnected(s.id) ? 'connected' : s.lastError ? 'error' : 'idle',
      lastCheckAt: s.lastCheckAt,
      lastError: s.lastError,
      botIds: mcpServers.botIds(s.id),
      createdAt: s.createdAt,
    };
  }
}

/** Text parts as they are; other content (images, resources) is named, not passed through. */
function resultText(content: { type: string; text?: string }[] | undefined): string {
  return (content ?? [])
    .map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type} content omitted]`))
    .join('\n');
}

const clip = (s: string) =>
  s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}… (truncated)` : s;
