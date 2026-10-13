import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Bot, Repos } from '@agenta/db';
import { PLATFORM_MCP_SERVER, type PlatformToolName, platformToolInputs } from '@agenta/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { hashMcpToken } from '../bots/mcp-token';
import { PLATFORM_TOOL_DESCRIPTIONS, type PlatformTools } from './tools';

type Log = {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
};

export const MCP_PATH = '/mcp';
/** Default per-bot budget: requests per window. A turn rarely needs more than a few calls a second. */
export const DEFAULT_MCP_RATE_LIMIT = { max: 120, windowMs: 60_000 };

export type PlatformMcpOptions = {
  repos: Pick<Repos, 'bots'>;
  tools: PlatformTools;
  log: Log;
  rateLimit?: { max: number; windowMs: number };
  now?: () => number;
};

/**
 * The Platform MCP server (PLAN F17): Streamable HTTP at /mcp, stateless (a fresh MCP server per request, bound to
 * the bot the bearer token belongs to). It listens on 127.0.0.1 and on the bot network's gateway, which bots reach
 * as host.docker.internal; both are inside the sandbox VM only.
 */
export class PlatformMcpServer {
  private readonly servers: Server[] = [];
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly now: () => number;

  constructor(private readonly opts: PlatformMcpOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Starts listening on one more address. Returns the bound port (useful with port 0 in tests). */
  async listen(host: string, port: number): Promise<number> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        this.opts.log.warn({ err }, 'platform MCP request failed');
        if (!res.headersSent) jsonError(res, 500, -32603, 'Internal error');
        else res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.servers.push(server);
    const bound = (server.address() as AddressInfo).port;
    this.opts.log.info({ host, port: bound }, 'platform MCP listening');
    return bound;
  }

  async close(): Promise<void> {
    await Promise.all(
      this.servers.splice(0).map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
            s.closeAllConnections();
          }),
      ),
    );
  }

  private authenticate(req: IncomingMessage): Bot | undefined {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    // Looked up by the token's SHA-256: a 256-bit random token's hash is safe to compare with a plain index.
    const bot = m?.[1] ? this.opts.repos.bots.getByMcpTokenHash(hashMcpToken(m[1])) : undefined;
    return bot && !bot.archivedAt ? bot : undefined;
  }

  /** Fixed window per bot. Returns seconds to wait when over budget. */
  private limited(botId: string): number | null {
    const { max, windowMs } = this.opts.rateLimit ?? DEFAULT_MCP_RATE_LIMIT;
    const now = this.now();
    let w = this.windows.get(botId);
    if (!w || now - w.start >= windowMs) {
      w = { start: now, count: 0 };
      this.windows.set(botId, w);
    }
    if (++w.count <= max) return null;
    return Math.max(1, Math.ceil((w.start + windowMs - now) / 1000));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (new URL(req.url ?? '/', 'http://x').pathname !== MCP_PATH)
      return jsonError(res, 404, -32601, 'Not found');
    const bot = this.authenticate(req);
    if (!bot) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="agenta"');
      return jsonError(res, 401, -32001, 'A valid bot token is required');
    }
    const wait = this.limited(bot.id);
    if (wait !== null) {
      this.opts.log.warn({ botId: bot.id }, 'platform MCP rate limit hit');
      res.setHeader('Retry-After', String(wait));
      return jsonError(res, 429, -32002, `Too many platform calls; retry in ${wait} s`);
    }
    const server = this.mcpFor(bot);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  private mcpFor(bot: Bot): McpServer {
    const server = new McpServer({ name: PLATFORM_MCP_SERVER, version: '1.0.0' });
    for (const name of Object.keys(platformToolInputs) as PlatformToolName[]) {
      server.registerTool(
        name,
        { description: PLATFORM_TOOL_DESCRIPTIONS[name], inputSchema: platformToolInputs[name].shape },
        async (args: unknown) => {
          try {
            const result = await this.opts.tools.call(bot, name, args);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
          } catch (err) {
            this.opts.log.debug({ botId: bot.id, tool: name, err }, 'platform tool refused');
            return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true };
          }
        },
      );
    }
    return server;
  }
}

function jsonError(res: ServerResponse, status: number, code: number, message: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}
