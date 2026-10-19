import { createHash } from 'node:crypto';
import type { Bot, BotMcpAccess, McpServer, Repos } from '@agenta/db';
import {
  GATEWAY_APPROVAL_ARG,
  GATEWAY_TOOL_SEPARATOR,
  type BotMcpAccessInput,
  type McpServerCreateInput,
  type McpServerUpdateInput,
  type McpOAuthStart,
  type McpServerView,
  type McpToolInfo,
  type McpToolPolicy,
  type ResearchSettings,
  VAR_REF_RE,
  type WebAccessMode,
  defaultDomains,
  mcpServerCreateSchema,
  networkAllowCommand,
  templateVars,
} from '@agenta/shared';
import type { ApprovalService } from '../approvals/service';
import type { InstructionMcpServer, InstructionTools } from '../engines/prompt';
import { type SecretSource, redactSecrets } from '../engines/secrets';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { type ConnectSpec, McpConnections, stdioEnv } from './connections';
import type { GatewayOAuth } from './oauth';

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
  /** This sandbox's name, for the owner's `sbx policy allow network --sandbox <name>` commands. */
  sandboxName?: string | null;
  /** Records an owner action in HUMAN_TODO.md (idempotent per `key`); unset: not recorded. */
  humanTodo?: (item: { key: string; text: string }) => void;
  /** OAuth sign-in for remote servers; unset: OAuth servers are reported as not supported. */
  oauth?: GatewayOAuth;
};

const MAX_RESULT_CHARS = 50_000;
const RESEARCH_KEY = 'research.webAccess';

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

/** The .env.local variables a server references (env values, and ${NAME} in header templates and arguments). */
export function secretNames(server: Pick<McpServer, 'envRefs' | 'headerRefs' | 'args'>): string[] {
  const names = new Set(Object.values(server.envRefs));
  for (const t of [...Object.values(server.headerRefs), ...server.args])
    for (const n of templateVars(t)) names.add(n);
  return [...names];
}

/** The saved domains, or the defaults for the server's command / URL. */
export const serverDomains = (s: Pick<McpServer, 'domains' | 'transport' | 'command' | 'url'>) =>
  s.domains.length ? s.domains : defaultDomains(s);

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

  /** Adds a server; `grantTo` gives it at once to every specialist (non-lead) or every bot (team defaults). */
  create(input: McpServerCreateInput, grantTo?: 'specialists' | 'all'): McpServerView {
    const data = mcpServerCreateSchema.parse(input);
    const { repos } = this.opts;
    if (repos.mcpServers.getBySlug(data.slug))
      throw new GatewayError('slug_taken', `A server with slug "${data.slug}" already exists`, 409);
    const s = repos.mcpServers.create(data);
    this.opts.log.info({ serverId: s.id, slug: s.slug, transport: s.transport }, 'MCP server added');
    if (grantTo)
      for (const bot of repos.bots.list())
        if (grantTo === 'all' || !bot.isLead)
          repos.mcpServers.setAccess(bot.id, [
            ...repos.mcpServers.accessForBot(bot.id).map((a) => ({
              serverId: a.serverId,
              tools: a.toolAllowlist,
              toolPolicies: a.toolPolicies,
            })),
            { serverId: s.id },
          ]);
    this.recordNetwork(s);
    return this.view(s);
  }

  async update(id: string, input: McpServerUpdateInput): Promise<McpServerView> {
    const before = this.server(id);
    if (input.slug && input.slug !== before.slug && this.opts.repos.mcpServers.getBySlug(input.slug))
      throw new GatewayError('slug_taken', `A server with slug "${input.slug}" already exists`, 409);
    const merged = { ...before, ...input };
    if (merged.transport === 'stdio' ? !merged.command : !merged.url)
      throw new GatewayError('invalid_body', 'A stdio server needs a command; an http server needs a url');
    const s = this.opts.repos.mcpServers.update(id, input)!;
    // Connection settings may have changed: reconnect on next use.
    await this.connections.close(id);
    this.recordNetwork(s);
    return this.view(s);
  }

  /** The bot's "Your tools" servers and the research setting, for its instruction files. */
  instructionTools(botId: string): InstructionTools {
    return { mcpServers: this.forRender(botId), webAccess: this.research().webAccess };
  }

  /** What a bot's instruction files list under "Your tools": its enabled, granted servers and visible tools. */
  forRender(botId: string): InstructionMcpServer[] {
    return this.grants(botId).map(({ server, access }) => ({
      name: server.name,
      slug: server.slug,
      description: server.description,
      tools: (server.toolsCache ?? [])
        .filter((t) => this.allowed(access, t.name) && this.policy(server, access, t.name) !== 'deny')
        .map((t) => `${server.slug}${GATEWAY_TOOL_SEPARATOR}${t.name}`),
    }));
  }

  async remove(id: string): Promise<void> {
    this.server(id);
    await this.connections.close(id);
    this.opts.oauth?.signOut(id);
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

  // ---- OAuth sign-in for remote servers ----

  /** Starts the owner's sign-in: returns the server's sign-in page, or `authorized` if tokens already work. */
  async oauthStart(id: string): Promise<McpOAuthStart> {
    const s = this.server(id);
    const oauth = this.opts.oauth;
    if (!oauth || s.transport !== 'http' || !s.url)
      throw new GatewayError('oauth_unavailable', 'Only remote (http) servers can sign in with OAuth');
    try {
      const result = await auth(oauth.provider(id), { serverUrl: s.url });
      if (result === 'AUTHORIZED') return { status: 'authorized', authorizationUrl: null };
      const url = oauth.takeAuthorizationUrl(id);
      if (!url) throw new Error('The server did not return a sign-in page');
      this.opts.log.info({ serverId: id }, 'MCP OAuth sign-in started');
      return { status: 'redirect', authorizationUrl: url.toString() };
    } catch (err) {
      throw new GatewayError('oauth_failed', `Sign-in could not start: ${this.explain(s, err)}`, 502);
    }
  }

  /** The browser came back from the sign-in page: exchange the code, then test the connection. */
  async oauthCallback(state: string, code: string): Promise<McpServerView> {
    const oauth = this.opts.oauth;
    const id = oauth?.serverForState(state);
    const s = id ? this.opts.repos.mcpServers.get(id) : undefined;
    if (!oauth || !id || !s?.url)
      throw new GatewayError('oauth_state', 'Unknown or expired sign-in; start again', 400);
    try {
      await auth(oauth.provider(id), { serverUrl: s.url, authorizationCode: code });
    } catch (err) {
      throw new GatewayError('oauth_failed', `Sign-in failed: ${this.explain(s, err)}`, 502);
    }
    this.opts.log.info({ serverId: id }, 'MCP OAuth sign-in completed');
    return this.test(id);
  }

  async oauthSignOut(id: string): Promise<McpServerView> {
    this.server(id);
    this.opts.oauth?.signOut(id);
    await this.connections.close(id);
    return this.get(id);
  }

  // ---- web research (PLAN F35) ----

  research(): ResearchSettings {
    const webAccess = this.opts.repos.settings.get<WebAccessMode>(RESEARCH_KEY) ?? 'per-domain';
    return { webAccess, command: this.researchCommand(webAccess) };
  }

  setResearch(webAccess: WebAccessMode): ResearchSettings {
    this.opts.repos.settings.set(RESEARCH_KEY, webAccess);
    const command = this.researchCommand(webAccess);
    if (!command) return { webAccess, command };
    this.opts.humanTodo?.({
      key: command,
      text:
        webAccess === 'broad'
          ? `(F35) Web research: let the bots reach any website (broad allowance, chosen in Settings). On the ` +
            `host: \`${command}\`. Undo with \`sbx policy rm network --sandbox ${this.sandbox} --resource "**"\`.`
          : `(F35) Web research, per-domain (chosen in Settings): when a bot reports a blocked page, allow just that ` +
            `domain on the host: \`${command}\`.`,
    });
    return { webAccess, command };
  }

  private researchCommand(mode: WebAccessMode): string | null {
    if (!this.sandbox) return null;
    return mode === 'broad'
      ? `sbx policy allow network --sandbox ${this.sandbox} "**"`
      : `sbx policy allow network --sandbox ${this.sandbox} <domain>`;
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
      const args = s.args.map((a) => a.replace(VAR_REF_RE, (_, n: string) => value(n)));
      return { transport: 'stdio', command: s.command!, args, cwd: s.cwd, env: stdioEnv(env) };
    }
    const headers = Object.fromEntries(
      Object.entries(s.headerRefs).map(([k, t]) => [k, t.replace(VAR_REF_RE, (_, n: string) => value(n))]),
    );
    const signedIn = this.opts.oauth?.hasTokens(s.id);
    return {
      transport: 'http',
      url: s.url!,
      headers,
      ...(signedIn ? { authProvider: this.opts.oauth!.provider(s.id) } : {}),
    };
  }

  private secretValues(s: McpServer): string[] {
    return [
      ...secretNames(s)
        .map((n) => this.opts.secrets.get(n))
        .filter((v): v is string => !!v),
      ...(this.opts.oauth?.secretValues(s.id) ?? []),
    ];
  }

  /** A readable, redacted error; a sandbox network-policy block says which domain to allow. */
  private explain(s: McpServer, err: unknown): string {
    const msg = redactSecrets((err as Error)?.message ?? String(err), this.secretValues(s)).slice(0, 2_000);
    if (/Blocked by|Approval required|network policy/i.test(msg) || /\b403\b.*proxy/i.test(msg)) {
      // e.g. "Approval required for mcp.context7.com:443." or "Blocked by network policy: domain x.com"
      const blocked =
        /(?:Blocked by network policy: domain|Approval required for) ([a-z0-9.-]*[a-z0-9])/i.exec(msg);
      const domains = blocked ? [blocked[1]!.toLowerCase()] : serverDomains(s);
      return (
        `Blocked by the sandbox network policy. Allow the domain on the host: ` +
        `${networkAllowCommand(domains, this.sandbox) ?? 'sbx policy allow network <domain>'}\n${msg}`
      );
    }
    if (s.transport === 'http' && /\b401\b|Unauthorized|invalid_token/i.test(msg)) {
      if (Object.keys(s.headerRefs).length)
        return `The server rejected the credentials (401). Check the .env.local value the headers reference.\n${msg}`;
      return this.opts.oauth
        ? `This server needs an OAuth sign-in: press "Sign in" on its card (its sign-in domains may need allowing too).\n${msg}`
        : 'This server needs an OAuth sign-in, which is not supported here. Use its API-key or token option ' +
            `(a header like Authorization = Bearer \${NAME}) or a local (stdio) version.\n${msg}`;
    }
    return msg;
  }

  private get sandbox(): string | null {
    return this.opts.sandboxName ?? null;
  }

  /** On save: the owner must allow the server's domains in the sandbox network policy (PLAN F35). */
  private recordNetwork(s: McpServer): void {
    const command = networkAllowCommand(serverDomains(s), this.sandbox);
    if (!command) return;
    this.opts.humanTodo?.({
      key: command,
      text:
        `(F35) Allow the network for the MCP server "${s.name}". On the host: \`${command}\`. ` +
        'Then press "Test connection" in Settings → MCP servers.',
    });
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
      description: s.description,
      domains: serverDomains(s),
      networkCommand: networkAllowCommand(serverDomains(s), this.sandbox),
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
      oauth: this.opts.oauth?.hasTokens(s.id) ? 'signed-in' : 'none',
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
