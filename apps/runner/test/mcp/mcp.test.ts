import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotService } from '../../src/bots/service';
import { MCP_TOKEN_FILE } from '../../src/bots/mcp-token';
import { botHomeDir } from '../../src/containers/home';
import { MockEngine } from '../../src/engines/mock';
import { PlatformMcpServer } from '../../src/mcp/server';
import { PlatformTools } from '../../src/mcp/tools';
import { ThreadService } from '../../src/threads/service';
import { type Harness, makeHarness, silent } from '../runs/helpers';

type Text = { content: { type: string; text: string }[]; isError?: boolean };

describe('Platform MCP server (F17)', () => {
  let h: Harness;
  let botsDir: string;
  let bots: BotService;
  let tools: PlatformTools;
  let mcp: PlatformMcpServer;
  let url: string;
  let clock = 0;
  const clients: Client[] = [];

  beforeEach(async () => {
    let platform: PlatformTools | undefined;
    h = makeHarness({
      adapters: [
        new MockEngine({
          tickMs: 1,
          platform: {
            call: async (name, input, botId) =>
              JSON.stringify(await platform!.call(h.repos.bots.get(botId)!, name, input)),
          },
        }),
      ],
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
    tools = platform = new PlatformTools({ repos: h.repos, threads, log: silent });
    clock = 0;
    mcp = new PlatformMcpServer({
      repos: h.repos,
      tools,
      log: silent,
      rateLimit: { max: 30, windowMs: 60_000 },
      now: () => clock,
    });
    url = `http://127.0.0.1:${await mcp.listen('127.0.0.1', 0)}/mcp`;
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await mcp.close();
    await h.service.idle();
    h.close();
  });

  const tokenOf = (botId: string) =>
    readFileSync(join(botHomeDir(botsDir, botId), MCP_TOKEN_FILE), 'utf8').trim();

  async function connect(token: string): Promise<Client> {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(client);
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const res = (await client.callTool({ name, arguments: args })) as Text;
    const text = res.content[0]?.text ?? '';
    return (res.isError ? { error: text } : JSON.parse(text)) as Record<string, unknown>;
  }

  const post = (headers: Record<string, string>) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

  it('rejects requests without a valid token, and tokens of archived bots', async () => {
    const bot = bots.create({ name: 'Writer', engine: 'mock' });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: 'Bearer agm_wrong' })).status).toBe(401);
    expect((await post({ authorization: tokenOf(bot.id) })).status).toBe(401); // no "Bearer"
    expect((await post({ authorization: `Bearer ${tokenOf(bot.id)}` })).status).toBe(200);
    bots.archive(bot.id);
    expect((await post({ authorization: `Bearer ${tokenOf(bot.id)}` })).status).toBe(401);
    expect((await fetch(url.replace('/mcp', '/other'))).status).toBe(404);
  });

  it('rate limits each bot separately', async () => {
    const a = bots.create({ name: 'A', engine: 'mock' });
    const b = bots.create({ name: 'B', engine: 'mock' });
    const auth = (id: string) => ({ authorization: `Bearer ${tokenOf(id)}` });
    for (let i = 0; i < 30; i++) expect((await post(auth(a.id))).status).toBe(200);
    const limited = await post(auth(a.id));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect((await post(auth(b.id))).status).toBe(200);
    clock += 60_000;
    expect((await post(auth(a.id))).status).toBe(200);
  });

  it('lists the session-1 tools; whoami, list_bots and list_threads answer for the calling bot', async () => {
    const writer = bots.create({ name: 'Writer', engine: 'mock', role: 'Writes docs' });
    bots.create({ name: 'Coder', engine: 'mock' });
    const c = await connect(tokenOf(writer.id));
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(
      [
        'ask_bot',
        'get_run_status',
        'list_bots',
        'list_threads',
        'post_message',
        'read_thread',
        'save_memory',
        'search_memory',
        'whoami',
      ].sort(),
    );
    const dm = h.repos.threads.findDm(writer.id)!.id;
    expect(await call(c, 'whoami')).toMatchObject({
      id: writer.id,
      handle: 'writer',
      role: 'Writes docs',
      is_lead: false,
      dm_thread_id: dm,
      current_run_id: null,
    });
    const team = (await call(c, 'list_bots')) as unknown as { handle: string; you?: boolean }[];
    expect(team.map((b) => [b.handle, b.you ?? false])).toEqual(
      expect.arrayContaining([
        ['writer', true],
        ['coder', false],
      ]),
    );
    expect(await call(c, 'list_threads')).toEqual([
      expect.objectContaining({ id: dm, kind: 'dm', members: ['writer'] }),
    ]);
  });

  it('read_thread and post_message only in threads the bot is a member of', async () => {
    const writer = bots.create({ name: 'Writer', engine: 'mock' });
    const coder = bots.create({ name: 'Coder', engine: 'mock' });
    const dm = h.repos.threads.findDm(writer.id)!.id;
    h.repos.messages.create({ threadId: dm, authorType: 'user', contentMd: 'hello writer' });
    const c = await connect(tokenOf(writer.id));

    expect(await call(c, 'post_message', { thread_id: dm, text: 'Progress: draft done.' })).toMatchObject({
      thread_id: dm,
    });
    const read = (await call(c, 'read_thread', { thread_id: dm })) as unknown as {
      messages: { author: string; text: string }[];
    };
    expect(read.messages.map((m) => [m.author, m.text])).toEqual([
      ['owner', 'hello writer'],
      ['writer', 'Progress: draft done.'],
    ]);
    expect(h.published.some((p) => p.channel === `thread:${dm}` && p.event.type === 'message.created')).toBe(
      true,
    );

    const other = h.repos.threads.findDm(coder.id)!.id;
    expect(await call(c, 'read_thread', { thread_id: other })).toEqual({
      error: expect.stringMatching(/member/),
    });
    expect(await call(c, 'post_message', { thread_id: other, text: 'hi' })).toEqual({
      error: expect.stringMatching(/not a member/),
    });
    expect(await call(c, 'read_thread', { thread_id: dm, limit: 0 })).toEqual({
      error: expect.stringMatching(/Invalid/),
    });
  });

  it('ask_bot posts in the teammate DM, starts their delegation run and get_run_status reports the reply', async () => {
    const lead = bots.create({ name: 'Lead', engine: 'mock' });
    const coder = bots.create({ name: 'Coder', engine: 'mock' });
    const c = await connect(tokenOf(lead.id));

    const asked = await call(c, 'ask_bot', { bot: '@coder', message: 'Please add a test.' });
    const dm = h.repos.threads.findDm(coder.id)!.id;
    expect(asked).toMatchObject({ bot: 'coder', thread_id: dm, status: 'queued' });
    const run = h.repos.runs.get(asked.run_id as string)!;
    expect(run).toMatchObject({ botId: coder.id, trigger: 'delegation', hopCount: 1, parentRunId: null });
    expect(run.prompt).toContain('Please add a test.');
    expect(run.prompt).toContain('Lead');
    expect(h.repos.messages.get(asked.message_id as string)).toMatchObject({
      authorType: 'bot',
      authorBotId: lead.id,
      mentions: [coder.id],
    });

    await h.service.idle();
    expect(await call(c, 'get_run_status', { run_id: run.id })).toMatchObject({
      bot: 'coder',
      status: 'succeeded',
      reply: expect.stringContaining('Please add a test.'),
    });

    expect(await call(c, 'ask_bot', { bot: 'lead', message: 'me?' })).toEqual({
      error: 'You cannot ask yourself',
    });
    expect(await call(c, 'ask_bot', { bot: 'nobody', message: 'hi' })).toEqual({
      error: expect.stringMatching(/No teammate called nobody/),
    });
    const group = h.repos.threads.create({ kind: 'group', title: 'Team' });
    h.repos.threads.addMember(group.id, coder.id);
    expect(await call(c, 'ask_bot', { bot: 'coder', message: 'x', thread_id: group.id })).toEqual({
      error: expect.stringMatching(/not a member/),
    });
    expect(await call(c, 'get_run_status', { run_id: 'run_nope' })).toEqual({
      error: 'Run run_nope not found',
    });
  });

  it('save_memory and search_memory keep bot memories private and shared ones shared', async () => {
    const a = bots.create({ name: 'Alpha', engine: 'mock' });
    const b = bots.create({ name: 'Beta', engine: 'mock' });
    const ca = await connect(tokenOf(a.id));
    const cb = await connect(tokenOf(b.id));
    await call(ca, 'save_memory', { title: 'Deploy notes', content: 'Use pnpm build before deploy.' });
    await call(ca, 'save_memory', {
      title: 'Team style',
      content: 'Short commits.',
      scope: 'shared',
      tags: ['deploy'],
    });
    await call(ca, 'save_memory', { title: 'Unrelated', content: 'Nothing here.' });

    const mine = (await call(ca, 'search_memory', { query: 'deploy' })) as unknown as { title: string }[];
    expect(mine.map((m) => m.title)).toEqual(['Deploy notes', 'Team style']);
    const theirs = (await call(cb, 'search_memory', { query: 'deploy' })) as unknown as { title: string }[];
    expect(theirs.map((m) => m.title)).toEqual(['Team style']);
    const sharedOnly = (await call(ca, 'search_memory', {
      query: 'deploy',
      scope: 'shared',
    })) as unknown as unknown[];
    expect(sharedOnly).toHaveLength(1);
    expect(h.repos.memories.list({ scope: 'bot', botId: a.id })).toHaveLength(2);
  });

  it('[mock:delegate] drives the platform tools in-process as the running bot', async () => {
    const lead = bots.create({ name: 'Agent A', engine: 'mock' });
    const worker = bots.create({ name: 'Worker', engine: 'mock' });
    const run = h.service.enqueue({
      botId: worker.id,
      threadId: h.repos.threads.findDm(worker.id)!.id,
      trigger: 'user',
      prompt: '[mock:delegate]',
    });
    await h.service.idle();
    const results = h.repos.runs
      .listEvents(run.id)
      .filter((e) => e.type === 'tool.result')
      .map((e) => e.payload as { output: string; isError?: boolean });
    expect(results[0]).toMatchObject({ isError: true, output: expect.stringMatching(/Unknown tool/) }); // create_task: session 2
    expect(results[1]?.isError).toBeUndefined();
    const asked = JSON.parse(results[1]!.output) as { run_id: string };
    expect(h.repos.runs.get(asked.run_id)).toMatchObject({
      botId: lead.id,
      trigger: 'delegation',
      parentRunId: run.id,
      hopCount: 1,
      status: 'succeeded',
    });
  });
});
