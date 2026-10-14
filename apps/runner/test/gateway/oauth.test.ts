import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalService } from '../../src/approvals/service';
import { BotService } from '../../src/bots/service';
import { loadConfig } from '../../src/config';
import { GatewayOAuth } from '../../src/gateway/oauth';
import { GatewayService } from '../../src/gateway/service';
import { buildServer } from '../../src/server';
import { type Harness, makeHarness, silent } from '../runs/helpers';

const ACCESS = 'oauth-access-token-0123456789abcdef';

/** A remote MCP server behind OAuth: protected-resource + authorization-server metadata, DCR, PKCE token exchange. */
function fakeOAuthServer() {
  const codes = new Map<string, string>(); // code → code_challenge
  const seen = { registered: 0, tokenRequests: 0 };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = new URL(req.url ?? '/', base);
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    const body = async () => {
      let raw = '';
      for await (const c of req) raw += c;
      return raw;
    };
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server'))
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    if (url.pathname === '/register') {
      seen.registered++;
      const meta = JSON.parse(await body()) as Record<string, unknown>;
      return json(201, { ...meta, client_id: 'client-1', client_id_issued_at: 1 });
    }
    if (url.pathname === '/token') {
      seen.tokenRequests++;
      const form = new URLSearchParams(await body());
      if (!codes.has(form.get('code') ?? '') || !form.get('code_verifier'))
        return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: ACCESS, token_type: 'Bearer', expires_in: 3600 });
    }
    if (url.pathname === '/mcp') {
      if (req.headers.authorization !== `Bearer ${ACCESS}`) {
        res.statusCode = 401;
        res.setHeader(
          'WWW-Authenticate',
          `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        );
        return res.end(JSON.stringify({ error: 'invalid_token' }));
      }
      const mcp = new McpServer({ name: 'remote', version: '1' });
      mcp.registerTool('whoami', { annotations: { readOnlyHint: true } }, async () => ({
        content: [{ type: 'text', text: `you are signed in with ${ACCESS}` }],
      }));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => void transport.close());
      await mcp.connect(transport);
      return transport.handleRequest(req, res);
    }
    json(404, {});
  });
  /** What the owner's browser does on the sign-in page: approve, and come back with a code. */
  const approve = (authorizationUrl: string) => {
    const u = new URL(authorizationUrl);
    const code = `code-${codes.size + 1}`;
    codes.set(code, u.searchParams.get('code_challenge') ?? '');
    return { code, state: u.searchParams.get('state')!, redirect: u.searchParams.get('redirect_uri')! };
  };
  return { server, approve, seen };
}

describe('MCP gateway OAuth sign-in (F35)', () => {
  let h: Harness;
  let fake: ReturnType<typeof fakeOAuthServer>;
  let dir: string;
  let gateway: GatewayService;
  let url: string;

  beforeEach(async () => {
    h = makeHarness({});
    fake = fakeOAuthServer();
    await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}/mcp`;
    dir = join(mkdtempSync(join(tmpdir(), 'agenta-oauth-')), 'mcp-oauth');
    gateway = new GatewayService({
      repos: h.repos,
      secrets: { get: () => undefined },
      approvals: new ApprovalService({ repos: h.repos }),
      log: silent,
      oauth: new GatewayOAuth(dir, 'http://localhost:3000/api/mcp-oauth/callback'),
    });
  });
  afterEach(async () => {
    await gateway.close();
    fake.server.closeAllConnections();
    await new Promise((r) => fake.server.close(r));
    h.close();
  });

  it('401 asks for sign-in; the callback exchanges the code; tools work; tokens stay out of the DB and results', async () => {
    const s = gateway.create({ name: 'Remote', slug: 'remote', transport: 'http', url });
    expect((await gateway.test(s.id)).lastError).toMatch(/needs an OAuth sign-in: press "Sign in"/);

    const start = await gateway.oauthStart(s.id);
    expect(start.status).toBe('redirect');
    const back = fake.approve(start.authorizationUrl!);
    expect(back.redirect).toBe('http://localhost:3000/api/mcp-oauth/callback');
    expect(fake.seen.registered).toBe(1);

    const signedIn = await gateway.oauthCallback(back.state, back.code);
    expect(signedIn).toMatchObject({ oauth: 'signed-in', lastError: null, state: 'connected' });
    expect(signedIn.tools.map((t) => t.name)).toEqual(['whoami']);

    const bots = new BotService({
      repos: h.repos,
      bus: h.bus,
      log: silent,
      botsDir: join(h.dir, 'bots'),
      runs: h.service,
    });
    const bot = bots.create({ name: 'Researcher', engine: 'mock' });
    gateway.setAccess(bot.id, [{ serverId: s.id }]);
    expect(await gateway.call(bot, 'remote__whoami', {})).toEqual({
      text: 'you are signed in with [redacted]',
      isError: false,
    });

    expect(JSON.stringify(h.db.$client.prepare('SELECT * FROM mcp_servers').all())).not.toContain(ACCESS);
    expect(JSON.stringify(gateway.list())).not.toContain(ACCESS);
    const [file] = readdirSync(dir);
    expect(readFileSync(join(dir, file!), 'utf8')).toContain(ACCESS);
    expect(statSync(join(dir, file!)).mode & 0o077).toBe(0);

    // A replayed or unknown state is refused.
    await expect(gateway.oauthCallback(back.state, back.code)).rejects.toThrow(/Unknown or expired sign-in/);
    expect((await gateway.oauthSignOut(s.id)).oauth).toBe('none');
  });

  it('the callback route sends the browser back to Settings with the result', async () => {
    const s = gateway.create({ name: 'Remote', slug: 'remote', transport: 'http', url });
    const app = await buildServer({ ...loadConfig({}), logLevel: 'silent' }, { repos: h.repos, gateway });
    try {
      const start = await app.inject({ method: 'POST', url: `/api/mcp-servers/${s.id}/oauth` });
      const back = fake.approve(start.json().authorizationUrl as string);
      const res = await app.inject({
        method: 'GET',
        url: `/api/mcp-oauth/callback?state=${back.state}&code=${back.code}`,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/settings/mcp?oauth&signed-in=remote');
      const denied = await app.inject({ method: 'GET', url: '/api/mcp-oauth/callback?error=access_denied' });
      expect(denied.headers.location).toBe('/settings/mcp?oauth&error=access_denied');
    } finally {
      await app.close();
    }
  });
});
