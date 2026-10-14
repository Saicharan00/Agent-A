import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalService } from '../../src/approvals/service';
import { MCP_TOKEN_FILE } from '../../src/bots/mcp-token';
import { BotService } from '../../src/bots/service';
import { loadConfig } from '../../src/config';
import { botHomeDir } from '../../src/containers/home';
import { MockEngine } from '../../src/engines/mock';
import { McpConnections, stdioEnv } from '../../src/gateway/connections';
import { GatewayService, annotationPolicy } from '../../src/gateway/service';
import { PlatformMcpServer, inProcessPlatform } from '../../src/mcp/server';
import { PlatformTools } from '../../src/mcp/tools';
import { buildServer } from '../../src/server';
import { ThreadService } from '../../src/threads/service';
import { type Harness, makeHarness, silent } from '../runs/helpers';

const FIXTURE = resolve(__dirname, '../../../../tests/fixtures/mcp-echo/server.mjs');
const SECRET = 'echo-secret-value-1234567890';

type Text = { content: { type: string; text: string }[]; isError?: boolean };

describe('MCP gateway (F35)', () => {
  let h: Harness;
  let botsDir: string;
  let bots: BotService;
  let approvals: ApprovalService;
  let gateway: GatewayService;
  let mcp: PlatformMcpServer;
  let url: string;
  let env: Record<string, string | undefined>;
  const clients: Client[] = [];

  beforeEach(async () => {
    const ref: { platform?: ReturnType<typeof inProcessPlatform> } = {};
    h = makeHarness({
      adapters: [new MockEngine({ tickMs: 1, platform: { call: (...a) => ref.platform!.call(...a) } })],
    });
    botsDir = join(h.dir, 'bots');
    bots = new BotService({ repos: h.repos, bus: h.bus, log: silent, botsDir, runs: h.service });
    const threads = new ThreadService({
      repos: h.repos,
      bus: h.bus,
      log: silent,
      botsDir,
      bots,
      runs: h.service,
    });
    approvals = new ApprovalService({ repos: h.repos });
    const tools = new PlatformTools({ repos: h.repos, threads, approvals, log: silent });
    env = { ECHO_KEY: SECRET };
    gateway = new GatewayService({
      repos: h.repos,
      secrets: { get: (n) => env[n] },
      approvals,
      log: silent,
    });
    ref.platform = inProcessPlatform(h.repos, tools, gateway);
    mcp = new PlatformMcpServer({ repos: h.repos, tools, gateway, log: silent });
    url = `http://127.0.0.1:${await mcp.listen('127.0.0.1', 0)}/mcp`;
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await mcp.close();
    await gateway.close();
    await h.service.idle();
    h.close();
  });

  const addEcho = () =>
    gateway.create({
      name: 'Echo',
      slug: 'echo',
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE],
      envRefs: { ECHO_API_KEY: 'ECHO_KEY' },
    });

  async function connect(botId: string): Promise<Client> {
    const token = readFileSync(join(botHomeDir(botsDir, botId), MCP_TOKEN_FILE), 'utf8').trim();
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(client);
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const res = (await client.callTool({ name, arguments: args })) as Text;
    return { text: res.content[0]?.text ?? '', isError: !!res.isError };
  }

  it('Test connection lists both tools with default policies from their annotations; no secret in the DB', async () => {
    const s = addEcho();
    expect(s.missingSecrets).toEqual([]);
    const tested = await gateway.test(s.id);
    expect(tested.lastError).toBeNull();
    expect(tested.tools.map((t) => [t.name, t.policy, t.description])).toEqual([
      ['echo', 'allow', 'Echoes the text back.'],
      ['save_note', 'approval', 'Saves a note (a write).'],
    ]);
    const rows = h.db.$client.prepare('SELECT * FROM mcp_servers').all();
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(JSON.stringify(rows)).toContain('ECHO_KEY');
  });

  it('a missing .env.local variable is reported by name', async () => {
    env = {};
    const s = addEcho();
    expect(s.missingSecrets).toEqual(['ECHO_KEY']);
    expect((await gateway.test(s.id)).lastError).toMatch(/Set ECHO_KEY in \.env\.local/);
  });

  it('tools/list is filtered per bot; a bot without access is refused', async () => {
    const granted = bots.create({ name: 'Researcher', engine: 'mock' });
    const other = bots.create({ name: 'Writer', engine: 'mock' });
    const s = addEcho();
    gateway.setAccess(granted.id, [{ serverId: s.id }]);

    const a = await connect(granted.id);
    const listed = (await a.listTools()).tools;
    expect(listed.map((t) => t.name)).toEqual(expect.arrayContaining(['echo__echo', 'echo__save_note']));
    const save = listed.find((t) => t.name === 'echo__save_note')!;
    expect(Object.keys(save.inputSchema.properties ?? {})).toEqual(['text', '_approval_id']);
    expect(listed.find((t) => t.name === 'whoami')).toBeDefined();
    expect(await call(a, 'echo__echo', { text: 'hi' })).toEqual({ text: 'echo: hi', isError: false });

    const b = await connect(other.id);
    expect((await b.listTools()).tools.some((t) => t.name.startsWith('echo__'))).toBe(false);
    expect(await call(b, 'echo__echo', { text: 'hi' })).toEqual({
      text: 'You do not have access to the tool echo__echo',
      isError: true,
    });
  });

  it('per-bot allowlist and deny policy hide tools; a disabled server hides all', async () => {
    const bot = bots.create({ name: 'Researcher', engine: 'mock' });
    const s = addEcho();
    const names = async () =>
      (await (await connect(bot.id)).listTools()).tools
        .map((t) => t.name)
        .filter((n) => n.startsWith('echo__'));

    gateway.setAccess(bot.id, [{ serverId: s.id, tools: ['echo'] }]);
    expect(await names()).toEqual(['echo__echo']);
    gateway.setAccess(bot.id, [{ serverId: s.id, toolPolicies: { echo: 'deny' } }]);
    expect(await names()).toEqual(['echo__save_note']);
    await expect(gateway.call(bot, 'echo__echo', { text: 'x' })).rejects.toThrow(/do not have access/);
    await gateway.update(s.id, { enabled: false });
    expect(await names()).toEqual([]);
  });

  it('an approval tool returns pending, then runs once with the approved id and the same arguments', async () => {
    const bot = bots.create({ name: 'Researcher', engine: 'mock' });
    const s = addEcho();
    gateway.setAccess(bot.id, [{ serverId: s.id }]);
    await gateway.test(s.id);

    const first = await gateway.call(bot, 'echo__save_note', { text: 'remember this' });
    const pending = JSON.parse(first.text) as { status: string; approval_id: string };
    expect(pending.status).toBe('pending');
    const approval = approvals.get(pending.approval_id);
    expect(approval).toMatchObject({
      botId: bot.id,
      action: 'Use echo__save_note',
      risk: 'high',
      status: 'pending',
    });
    expect(approval.detailsMd).toContain('remember this');

    const retry = { text: 'remember this', _approval_id: pending.approval_id };
    await expect(gateway.call(bot, 'echo__save_note', retry)).rejects.toThrow(/still pending/);
    approvals.decide(pending.approval_id, { status: 'approved' });
    await expect(gateway.call(bot, 'echo__save_note', { ...retry, text: 'something else' })).rejects.toThrow(
      /not given for this call/,
    );
    expect(await gateway.call(bot, 'echo__save_note', retry)).toEqual({
      text: 'saved note #1: remember this',
      isError: false,
    });
    await expect(gateway.call(bot, 'echo__save_note', retry)).rejects.toThrow(/already used/);

    const other = bots.create({ name: 'Writer', engine: 'mock' });
    gateway.setAccess(other.id, [{ serverId: s.id }]);
    await expect(gateway.call(other, 'echo__save_note', retry)).rejects.toThrow(/not given for this call/);
  });

  it('secrets reach the server process but are redacted from results; other runner secrets are not passed', async () => {
    const bot = bots.create({ name: 'Researcher', engine: 'mock' });
    gateway.setAccess(bot.id, [{ serverId: addEcho().id }]);
    expect(await gateway.call(bot, 'echo__echo', { text: '__key__' })).toEqual({
      text: 'key=[redacted]',
      isError: false,
    });
    process.env.AGENTA_TEST_SECRET = 'should-not-leak';
    try {
      const childEnv = stdioEnv({ ECHO_API_KEY: SECRET });
      expect(childEnv.ECHO_API_KEY).toBe(SECRET);
      expect(childEnv.AGENTA_TEST_SECRET).toBeUndefined();
      expect(childEnv.PATH).toBeTruthy();
    } finally {
      delete process.env.AGENTA_TEST_SECRET;
    }
  });

  it('a crashed server is restarted on the next call', async () => {
    const bot = bots.create({ name: 'Researcher', engine: 'mock' });
    const s = addEcho();
    gateway.setAccess(bot.id, [{ serverId: s.id }]);
    expect((await gateway.call(bot, 'echo__echo', { text: 'one' })).text).toBe('echo: one');
    const crashed = await gateway.call(bot, 'echo__echo', { text: '__crash__' });
    expect(crashed.isError).toBe(true);
    expect(gateway.get(s.id).state).not.toBe('connected');
    expect(await gateway.call(bot, 'echo__echo', { text: 'two' })).toEqual({
      text: 'echo: two',
      isError: false,
    });
    expect(gateway.get(s.id).state).toBe('connected');
  });

  it('[mock:mcp] calls the read tool, and the write tool after approval', async () => {
    const bot = bots.create({ name: 'Researcher', engine: 'mock' });
    const s = addEcho();
    gateway.setAccess(bot.id, [{ serverId: s.id }]);
    const threadId = h.repos.threads.findDm(bot.id)!.id;
    const results = async (prompt: string) => {
      const run = h.service.enqueue({ botId: bot.id, threadId, trigger: 'user', prompt });
      await h.service.idle();
      expect(h.repos.runs.get(run.id)?.status).toBe('succeeded');
      return h.repos.runs
        .listEvents(run.id)
        .filter((e) => e.type === 'tool.call' || e.type === 'tool.result')
        .map((e) => e.payload as { name?: string; output?: string; isError?: boolean });
    };

    const first = await results('[mock:mcp] gw:echo__echo gw:echo__save_note');
    expect(first.map((e) => e.name ?? e.output?.split('\n')[0])).toEqual([
      'mcp__agenta__echo__echo',
      'echo: hello from the mock bot',
      'mcp__agenta__echo__save_note',
      '{',
    ]);
    const { approval_id } = JSON.parse(first[3]!.output!) as { approval_id: string };
    expect(approvals.get(approval_id).runId).toBeTruthy();
    approvals.decide(approval_id, { status: 'approved' });

    const retry = await results(`[mock:mcp] gw:echo__save_note ${approval_id}`);
    expect(retry[1]).toMatchObject({
      callId: 'mock-mcp-1',
      output: 'saved note #1: hello from the mock bot',
    });
    expect(retry[1]).not.toHaveProperty('isError');

    // A bot without access: the call is rejected and shown as a failed tool result.
    const other = bots.create({ name: 'Writer', engine: 'mock' });
    const run = h.service.enqueue({
      botId: other.id,
      threadId: h.repos.threads.findDm(other.id)!.id,
      trigger: 'user',
      prompt: '[mock:mcp] gw:echo__echo',
    });
    await h.service.idle();
    const refused = h.repos.runs.listEvents(run.id).find((e) => e.type === 'tool.result')!.payload;
    expect(refused).toMatchObject({ isError: true, output: 'You do not have access to the tool echo__echo' });
  });

  it('connects to an HTTP server with header secrets filled in from .env.local', async () => {
    const seen: (string | undefined)[] = [];
    const http = createServer((req, res) => {
      seen.push(req.headers.authorization);
      const server = new McpServer({ name: 'remote', version: '1' });
      server.registerTool(
        'ping',
        { description: 'Pong.', annotations: { readOnlyHint: true } },
        async () => ({
          content: [{ type: 'text', text: 'pong' }],
        }),
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => void transport.close());
      void server.connect(transport).then(() => transport.handleRequest(req, res));
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    try {
      const bot = bots.create({ name: 'Researcher', engine: 'mock' });
      const s = gateway.create({
        name: 'Remote',
        slug: 'remote',
        transport: 'http',
        url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`,
        headerRefs: { Authorization: 'Bearer ${ECHO_KEY}' },
      });
      gateway.setAccess(bot.id, [{ serverId: s.id }]);
      expect((await gateway.test(s.id)).tools.map((t) => [t.name, t.policy])).toEqual([['ping', 'allow']]);
      expect(await gateway.call(bot, 'remote__ping', {})).toEqual({ text: 'pong', isError: false });
      expect(seen.every((a) => a === `Bearer ${SECRET}`)).toBe(true);
      expect(JSON.stringify(h.db.$client.prepare('SELECT * FROM mcp_servers').all())).not.toContain(SECRET);
    } finally {
      await gateway.close();
      http.closeAllConnections();
      await new Promise((r) => http.close(r));
    }
  });

  it('idle connections are shut down and reconnect lazily', async () => {
    const conns = new McpConnections({ log: silent, idleMs: 30 });
    const spec = () => ({
      transport: 'stdio' as const,
      command: process.execPath,
      args: [FIXTURE],
      cwd: null,
      env: stdioEnv({}),
    });
    expect((await conns.listTools('x', spec)).length).toBe(2);
    expect(conns.isConnected('x')).toBe(true);
    await new Promise((r) => setTimeout(r, 120));
    expect(conns.isConnected('x')).toBe(false);
    expect((await conns.callTool('x', spec, 'echo', { text: 'back' })).content).toEqual([
      { type: 'text', text: 'echo: back' },
    ]);
    await conns.closeAll();
  });

  it('default policy: read-only allow, destructive asks even when the server default is allow', () => {
    const tool = (annotations: { readOnlyHint?: boolean; destructiveHint?: boolean }) => ({
      name: 't',
      inputSchema: {},
      annotations,
    });
    expect(annotationPolicy(tool({ readOnlyHint: true }), 'deny')).toBe('allow');
    expect(annotationPolicy(tool({ destructiveHint: true }), 'allow')).toBe('approval');
    expect(annotationPolicy(tool({}), 'allow')).toBe('allow');
    expect(annotationPolicy(undefined, 'approval')).toBe('approval');
  });

  describe('HTTP API', () => {
    const config = { ...loadConfig({}), logLevel: 'silent' as const };

    it('creates, validates, rejects duplicate slugs, grants bots and deletes', async () => {
      const app = await buildServer(config, { repos: h.repos, gateway });
      try {
        const bad = await app.inject({
          method: 'POST',
          url: '/api/mcp-servers',
          payload: { name: 'X', slug: 'x', transport: 'stdio' },
        });
        expect(bad.statusCode).toBe(400);
        expect(bad.json().error.code).toBe('invalid_body');
        const literal = await app.inject({
          method: 'POST',
          url: '/api/mcp-servers',
          payload: {
            name: 'X',
            slug: 'x',
            transport: 'http',
            url: 'https://x.test/mcp',
            headerRefs: { Authorization: 'Bearer sk-123' },
          },
        });
        expect(literal.statusCode).toBe(400);

        const payload = { name: 'Echo', slug: 'echo', transport: 'stdio', command: 'node', args: [FIXTURE] };
        const created = await app.inject({ method: 'POST', url: '/api/mcp-servers', payload });
        expect(created.statusCode).toBe(201);
        const id = created.json().id as string;
        expect(created.json()).toMatchObject({
          slug: 'echo',
          enabled: true,
          defaultPolicy: 'approval',
          tools: [],
        });
        expect((await app.inject({ method: 'POST', url: '/api/mcp-servers', payload })).statusCode).toBe(409);

        const patched = await app.inject({
          method: 'PATCH',
          url: `/api/mcp-servers/${id}`,
          payload: { name: 'Echo 2' },
        });
        expect(patched.json()).toMatchObject({ name: 'Echo 2', args: [FIXTURE], defaultPolicy: 'approval' });

        const bot = bots.create({ name: 'Researcher', engine: 'mock' });
        const put = await app.inject({
          method: 'PUT',
          url: `/api/bots/${bot.id}/mcp-access`,
          payload: { access: [{ serverId: id, tools: ['echo'] }] },
        });
        expect(put.json()).toEqual([
          { botId: bot.id, serverId: id, toolAllowlist: ['echo'], toolPolicies: {} },
        ]);
        expect((await app.inject({ method: 'GET', url: '/api/mcp-servers' })).json()[0].botIds).toEqual([
          bot.id,
        ]);
        const unknown = await app.inject({
          method: 'PUT',
          url: `/api/bots/${bot.id}/mcp-access`,
          payload: { access: [{ serverId: 'mcs_nope' }] },
        });
        expect(unknown.statusCode).toBe(404);

        expect((await app.inject({ method: 'DELETE', url: `/api/mcp-servers/${id}` })).statusCode).toBe(204);
        expect(gateway.accessFor(bot.id)).toEqual([]);
        expect((await app.inject({ method: 'GET', url: `/api/mcp-servers/${id}` })).statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });
  });
});
