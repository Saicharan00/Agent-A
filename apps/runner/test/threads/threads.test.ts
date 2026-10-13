import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MessagePage, SendMessageResponse, ThreadView } from '@agenta/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotService } from '../../src/bots/service';
import { loadConfig } from '../../src/config';
import { MockEngine } from '../../src/engines/mock';
import { buildServer } from '../../src/server';
import { ThreadService, inboxDir } from '../../src/threads/service';
import { type Harness, makeHarness, silent } from '../runs/helpers';

describe('threads API', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const };
  let h: Harness;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let botsDir: string;
  let botId: string;
  let dm: string;

  beforeEach(async () => {
    h = makeHarness({ adapters: [new MockEngine({ slowMs: 60_000, tickMs: 1 })] });
    botsDir = join(h.dir, 'bots');
    const bots = new BotService({ repos: h.repos, bus: h.bus, log: silent, botsDir, runs: h.service });
    const threads = new ThreadService({
      repos: h.repos,
      bus: h.bus,
      log: silent,
      botsDir,
      bots,
      runs: h.service,
    });
    app = await buildServer(config, { repos: h.repos, runs: h.service, bots, threads });
    const bot = bots.create({ name: 'Helper', engine: 'mock' });
    botId = bot.id;
    dm = h.repos.threads.findDm(bot.id)!.id;
  });
  afterEach(async () => {
    await app.close();
    h.close();
  });

  const send = (threadId: string, payload: unknown) =>
    app.inject({ method: 'POST', url: `/api/threads/${threadId}/messages`, payload: payload as object });
  const upload = (id: string, name: string, body: Buffer | string, type = 'application/octet-stream') =>
    app.inject({
      method: 'POST',
      url: `/api/bots/${id}/inbox?name=${encodeURIComponent(name)}`,
      headers: { 'content-type': type },
      payload: body,
    });

  it('returns the thread with its member bots', async () => {
    const res = await app.inject({ url: `/api/threads/${dm}` });
    expect(res.statusCode).toBe(200);
    const t = res.json<ThreadView>();
    expect(t).toMatchObject({ id: dm, kind: 'dm', title: 'Helper', explainMode: false });
    expect(t.members.map((b) => b.id)).toEqual([botId]);
    expect(t.members[0]).not.toHaveProperty('mcpTokenHash');
    expect((await app.inject({ url: '/api/threads/thr_nope' })).statusCode).toBe(404);
  });

  it('posting creates the user message, queues a run and the reply lands in the thread', async () => {
    const res = await send(dm, { content: '  [mock:hello] hi  ' });
    expect(res.statusCode).toBe(201);
    const body = res.json<SendMessageResponse>();
    expect(body.message).toMatchObject({ authorType: 'user', contentMd: '[mock:hello] hi', threadId: dm });
    expect(body.runs).toHaveLength(1);
    const run = body.runs[0]!;
    expect(run).toMatchObject({ botId, threadId: dm, trigger: 'user', status: 'queued', engine: 'mock' });
    expect(run).not.toHaveProperty('prompt');
    expect(body.message.runId).toBe(run.id);
    expect(h.repos.runs.get(run.id)!.prompt).toBe('[mock:hello] hi');
    expect(h.repos.sessions.get(botId, dm)?.lastSeenMessageId).toBe(body.message.id);

    // Published with its run id, so live clients can place the reply under it.
    expect(h.published).toContainEqual({
      channel: `thread:${dm}`,
      event: expect.objectContaining({
        type: 'message.created',
        messageId: body.message.id,
        runId: run.id,
        authorType: 'user',
      }),
    });

    await h.service.idle();
    const page = (await app.inject({ url: `/api/threads/${dm}/messages` })).json<MessagePage>();
    expect(page.hasMore).toBe(false);
    expect(page.messages.map((m) => m.authorType)).toEqual(['user', 'bot']);
    expect(page.messages[1]).toMatchObject({ runId: run.id, authorBotId: botId });
    expect(page.messages[1]!.contentMd).toContain("Hello! I'm Helper");
  });

  it('keeps the stored engine of an existing session when recording what the bot has seen', async () => {
    h.repos.sessions.upsert({ botId, threadId: dm, engine: 'claude', engineSessionId: 'claude-session' });
    await send(dm, { content: 'hello' });
    expect(h.repos.sessions.get(botId, dm)).toMatchObject({
      engine: 'claude',
      engineSessionId: 'claude-session',
    });
    h.service.stop();
  });

  it('pages history backwards with hasMore', async () => {
    for (let i = 0; i < 5; i++) {
      h.repos.messages.create({ threadId: dm, authorType: 'user', contentMd: `m${i}` });
    }
    const first = (await app.inject({ url: `/api/threads/${dm}/messages?limit=2` })).json<MessagePage>();
    expect(first.messages.map((m) => m.contentMd)).toEqual(['m3', 'm4']);
    expect(first.hasMore).toBe(true);
    const older = (
      await app.inject({ url: `/api/threads/${dm}/messages?limit=2&before=${first.messages[0]!.id}` })
    ).json<MessagePage>();
    expect(older.messages.map((m) => m.contentMd)).toEqual(['m1', 'm2']);
    const oldest = (
      await app.inject({ url: `/api/threads/${dm}/messages?limit=2&before=${older.messages[0]!.id}` })
    ).json<MessagePage>();
    expect(oldest).toMatchObject({ hasMore: false });
    expect(oldest.messages.map((m) => m.contentMd)).toEqual(['m0']);

    expect((await app.inject({ url: `/api/threads/${dm}/messages?limit=0` })).json()).toMatchObject({
      error: { code: 'invalid_query' },
    });
    const other = h.repos.threads.create({ kind: 'group', title: 'G' });
    const foreign = h.repos.messages.create({ threadId: other.id, authorType: 'user', contentMd: 'x' });
    expect((await app.inject({ url: `/api/threads/${dm}/messages?before=${foreign.id}` })).statusCode).toBe(
      404,
    );
  });

  it('validates the message body', async () => {
    for (const payload of [{}, { content: '   ' }, { content: 'x', extra: 1 }, { attachments: ['../x'] }]) {
      const res = await send(dm, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'invalid_body' } });
    }
    expect((await send('thr_missing', { content: 'hi' })).statusCode).toBe(404);
    expect(h.repos.messages.listByThread(dm)).toHaveLength(0);
  });

  it('refuses to post to archived bots and threads', async () => {
    h.repos.bots.archive(botId);
    expect((await send(dm, { content: 'hi' })).json()).toMatchObject({ error: { code: 'bot_archived' } });
    h.repos.threads.archive(dm);
    expect((await send(dm, { content: 'hi' })).json()).toMatchObject({ error: { code: 'thread_archived' } });
    expect(h.repos.messages.listByThread(dm)).toHaveLength(0);
  });

  it('stores a group message without starting runs (routing arrives with group chats)', async () => {
    const g = h.repos.threads.create({ kind: 'group', title: 'Team', memberBotIds: [botId] });
    const res = await send(g.id, { content: 'hello team' });
    expect(res.statusCode).toBe(201);
    expect(res.json<SendMessageResponse>()).toMatchObject({ runs: [], message: { runId: null } });
  });

  it('uploads attachments into the inbox and references them in the message and prompt', async () => {
    const up = await upload(botId, 'C:\\Users\\me\\notes.txt', 'hello file');
    expect(up.statusCode).toBe(201);
    expect(up.json()).toEqual({ name: 'notes.txt', path: '/home/bot/work/inbox/notes.txt', size: 10 });
    expect(readFileSync(join(inboxDir(botsDir, botId), 'notes.txt'), 'utf8')).toBe('hello file');

    // Same name again: never overwritten.
    const again = await upload(botId, 'notes.txt', 'second');
    expect(again.json()).toMatchObject({ name: 'notes-1.txt' });
    expect(readFileSync(join(inboxDir(botsDir, botId), 'notes.txt'), 'utf8')).toBe('hello file');

    const hidden = await upload(botId, '../../.bashrc', 'x');
    expect(hidden.json()).toMatchObject({ name: 'bashrc' });
    expect(existsSync(join(botsDir, botId, 'home', '.bashrc'))).toBe(false);

    const empty = await upload(botId, 'empty.bin', Buffer.alloc(0));
    expect(empty.json()).toMatchObject({ name: 'empty.bin', size: 0 });

    const res = await send(dm, { content: 'Summarise this', attachments: ['notes.txt', 'notes-1.txt'] });
    expect(res.statusCode).toBe(201);
    const body = res.json<SendMessageResponse>();
    expect(body.message.contentMd).toBe('Summarise this\n\n📎 `inbox/notes.txt` · `inbox/notes-1.txt`');
    expect(h.repos.runs.get(body.runs[0]!.id)!.prompt).toBe(
      'Summarise this\n\nThe user attached files:\n- /home/bot/work/inbox/notes.txt\n- /home/bot/work/inbox/notes-1.txt',
    );

    // An attachment alone is a valid message.
    expect((await send(dm, { attachments: ['empty.bin'] })).statusCode).toBe(201);
    expect((await send(dm, { content: 'x', attachments: ['never-uploaded.txt'] })).json()).toMatchObject({
      error: { code: 'attachment_not_found' },
    });
    h.service.stop();
  });

  it('rejects uploads that are not raw bytes, too large, or for unknown bots', async () => {
    expect((await upload(botId, 'a.txt', 'x', 'text/plain')).statusCode).toBe(415);
    expect((await upload('bot_nope', 'a.txt', 'x')).statusCode).toBe(404);
    const big = await upload(botId, 'big.bin', Buffer.alloc(10 * 1024 * 1024 + 1));
    expect(big.statusCode).toBe(413);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/bots/${botId}/inbox`,
          headers: { 'content-type': 'application/octet-stream' },
          payload: 'x',
        })
      ).statusCode,
    ).toBe(400);
  });
});
