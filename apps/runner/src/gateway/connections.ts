import { GATEWAY_CALL_TIMEOUT_MS, GATEWAY_IDLE_MS, type McpToolInfo } from '@agenta/shared';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  type CallToolResult,
  CallToolResultSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

type Log = { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };

/** How to reach one server, with secret values already filled in (never stored or logged). */
export type ConnectSpec =
  | { transport: 'stdio'; command: string; args: string[]; cwd: string | null; env: Record<string, string> }
  | { transport: 'http'; url: string; headers: Record<string, string>; authProvider?: OAuthClientProvider };

/**
 * Proxy and CA settings a stdio server needs to reach the internet through the sandbox proxy (like F04/F05).
 * Only these, plus the SDK's safe defaults (HOME, PATH, …): the runner's own env holds .env.local secrets that a
 * server must not see unless it references them.
 */
const PASSTHROUGH_ENV = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_ENV_PROXY',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
];

export function stdioEnv(secretEnv: Record<string, string>): Record<string, string> {
  const env = getDefaultEnvironment();
  for (const name of PASSTHROUGH_ENV) {
    const v = process.env[name];
    if (v) env[name] = v;
  }
  return { ...env, ...secretEnv };
}

type Conn = { client: Client; transport: Transport; idle?: NodeJS.Timeout; stderr: string };

export type McpConnectionsOptions = {
  log: Log;
  idleMs?: number;
  callTimeoutMs?: number;
  /** A connected server announced that its tool list changed. */
  onToolsChanged?: (serverId: string) => void;
};

/**
 * Live MCP client connections, one per server (PLAN F35). Lazy: a server is started or connected on first use and
 * shut down after `idleMs` without calls. A server whose process exits or whose connection drops is forgotten, so
 * the next call starts it again (auto-restart on crash).
 */
export class McpConnections {
  private readonly conns = new Map<string, Conn>();
  private readonly pending = new Map<string, Promise<Conn>>();
  private readonly idleMs: number;
  private readonly callTimeoutMs: number;

  constructor(private readonly opts: McpConnectionsOptions) {
    this.idleMs = opts.idleMs ?? GATEWAY_IDLE_MS;
    this.callTimeoutMs = opts.callTimeoutMs ?? GATEWAY_CALL_TIMEOUT_MS;
  }

  isConnected(serverId: string): boolean {
    return this.conns.has(serverId);
  }

  async listTools(serverId: string, spec: () => ConnectSpec): Promise<McpToolInfo[]> {
    const conn = await this.get(serverId, spec);
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await conn.client.listTools(cursor ? { cursor } : undefined, {
        timeout: this.callTimeoutMs,
      });
      for (const t of page.tools)
        tools.push({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          inputSchema: t.inputSchema as Record<string, unknown>,
          ...(t.annotations ? { annotations: t.annotations } : {}),
        });
      cursor = page.nextCursor;
    } while (cursor && tools.length < 1_000);
    return tools;
  }

  async callTool(
    serverId: string,
    spec: () => ConnectSpec,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const conn = await this.get(serverId, spec);
    try {
      const result = await conn.client.callTool({ name, arguments: args }, CallToolResultSchema, {
        timeout: this.callTimeoutMs,
      });
      return result as CallToolResult;
    } catch (err) {
      throw withStderr(err, conn.stderr);
    }
  }

  /** Disconnects (and stops a stdio server). The next use connects again. */
  async close(serverId: string): Promise<void> {
    const conn = this.conns.get(serverId);
    this.conns.delete(serverId);
    if (!conn) return;
    clearTimeout(conn.idle);
    await conn.client.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.conns.keys()].map((id) => this.close(id)));
  }

  private async get(serverId: string, spec: () => ConnectSpec): Promise<Conn> {
    let conn = this.conns.get(serverId);
    if (!conn) {
      let p = this.pending.get(serverId);
      if (!p) {
        p = this.connect(serverId, spec()).finally(() => this.pending.delete(serverId));
        this.pending.set(serverId, p);
      }
      conn = await p;
    }
    this.touch(serverId, conn);
    return conn;
  }

  private touch(serverId: string, conn: Conn): void {
    clearTimeout(conn.idle);
    conn.idle = setTimeout(() => {
      this.opts.log.info({ serverId }, 'MCP server idle: disconnecting');
      void this.close(serverId);
    }, this.idleMs);
    conn.idle.unref();
  }

  private async connect(serverId: string, spec: ConnectSpec): Promise<Conn> {
    if (spec.transport === 'stdio') {
      const transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args,
        env: spec.env,
        ...(spec.cwd ? { cwd: spec.cwd } : {}),
        stderr: 'pipe',
      });
      const conn: Conn = { client: this.client(serverId), transport, stderr: '' };
      // The last bit of stderr explains most start-up failures (missing package, blocked download, bad key).
      transport.stderr?.on('data', (d: Buffer) => {
        conn.stderr = (conn.stderr + d.toString()).slice(-2_000);
      });
      try {
        await conn.client.connect(transport, { timeout: this.callTimeoutMs });
      } catch (err) {
        await conn.client.close().catch(() => undefined);
        throw withStderr(err, conn.stderr);
      }
      return this.adopt(serverId, conn);
    }
    const url = new URL(spec.url);
    const requestInit = { headers: spec.headers };
    // Streamable HTTP first; servers that only speak the older SSE transport get a second try.
    try {
      const client = this.client(serverId);
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit,
        authProvider: spec.authProvider,
      });
      await client.connect(transport, { timeout: this.callTimeoutMs });
      return this.adopt(serverId, { client, transport, stderr: '' });
    } catch (err) {
      if (!/\b(404|405)\b/.test((err as Error).message)) throw err;
      const client = this.client(serverId);
      const transport = new SSEClientTransport(url, {
        requestInit,
        authProvider: spec.authProvider,
        eventSourceInit: { fetch: withHeaders(spec.headers) },
      });
      await client.connect(transport, { timeout: this.callTimeoutMs });
      return this.adopt(serverId, { client, transport, stderr: '' });
    }
  }

  private client(serverId: string): Client {
    const client = new Client({ name: 'agenta-gateway', version: '1.0.0' });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.opts.onToolsChanged?.(serverId);
    });
    return client;
  }

  private adopt(serverId: string, conn: Conn): Conn {
    this.conns.set(serverId, conn);
    conn.client.onclose = () => {
      // Exited or dropped: forget it so the next call reconnects (only if it is still the current connection).
      if (this.conns.get(serverId) !== conn) return;
      clearTimeout(conn.idle);
      this.conns.delete(serverId);
      this.opts.log.warn({ serverId }, 'MCP server connection closed');
    };
    this.opts.log.info({ serverId }, 'MCP server connected');
    return conn;
  }
}

/** fetch for the SSE stream that sends the configured headers (EventSource can't set them itself). */
function withHeaders(headers: Record<string, string>): typeof fetch {
  return (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as object), ...headers } });
}

function withStderr(err: unknown, stderr: string): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  const tail = stderr.trim();
  return tail ? new Error(`${e.message}\n${tail.split('\n').slice(-5).join('\n')}`) : e;
}
