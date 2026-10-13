import { join } from 'node:path';
import { type MessageView, type RunView, type ThreadView, parseMentions } from '@agenta/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotService } from '../../src/bots/service';
import { loadConfig } from '../../src/config';
import { MockEngine } from '../../src/engines/mock';
import { PlatformTools } from '../../src/mcp/tools';
import { buildServer } from '../../src/server';
import { MAX_HOPS, ThreadService } from '../../src/threads/service';
import { type Harness, makeHarness, silent } from '../runs/helpers';

describe('parseMentions', () => {
  const bots = [
    { id: 'b1', slug: 'alice' },
    { id: 'b2', slug: 'bob-2' },
  ];
  it('finds @slugs in order, once, case-insensitively, at word starts only', () => {
    expect(parseMentions('@Bob-2 and @alice, then @alice again', bots)).toEqual(['b2', 'b1']);
    expect(parseMentions('mail me at x@alice.com or @nobody', bots)).toEqual([]);
    expect(parseMentions('hey @alice.', bots)).toEqual(['b1']);
  });
  it('ignores code and quoted lines', () => {
    expect(parseMentions('`@alice` and\n```\n@bob-2\n```', bots)).toEqual([]);
    expect(parseMentions('> @alice said hi\nok @bob-2', bots)).toEqual(['b2']);
  });
});

// F18 session 1: groups, members, @mention routing, moderator, bot-to-bot mentions, group prompt context.
describe('group chats', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const };
  let h: Harness;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let threads: ThreadService;
  let lead: string;
  let alice: string;
  let bob: string;

  beforeEach(async () => {
    h = makeHarness({
      adapters: [
        new MockEngine({
          tickMs: 1,
          platform: {
            call: async (name, input, botId) =>
              JSON.stringify(await platform.call(h.repos.bots.get(botId)!, name, input)),
          },
        }),
      ],
    });
    const botsDir = join(h.dir, 'bots');
    const bots = new BotService({ repos: h.repos, bus: h.bus, log: silent, botsDir, runs: h.service });
    threads = new ThreadService({ repos: h.repos, bus: h.bus, log: silent, botsDir, bots, runs: h.service });
    // Called by the mock engine only once runs start, after this line.
    const platform = new PlatformTools({ repos: h.repos, threads, log: silent });
    h.service.onReply = (run, reply) => void threads.routeBotMessage(reply, run);
    app = await buildServer(config, { repos: h.repos, runs: h.service, bots, threads });
    lead = bots.create({ name: 'Agent A', engine: 'mock', role: 'Lead AI Engineer' }).id;
    h.repos.bots.update(lead, { isLead: true });
    alice = bots.create({ name: 'Alice', engine: 'mock', role: 'Frontend' }).id;
    bob = bots.create({ name: 'Bob', engine: 'mock', role: 'Backend' }).id;
  });
  afterEach(async () => {
    await app.close();
    h.close();
  });

  const create = async (payload: object) => {
    const res = await app.inject({ method: 'POST', url: '/api/threads', payload });
    return { status: res.statusCode, body: res.json<ThreadView>() };
  };
  const send = async (id: string, content: string) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${id}/messages`,
      payload: { content },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ message: MessageView; runs: RunView[] }>();
  };

  it('creates a group, lists it, and validates members and moderator', async () => {
    const { status, body } = await create({
      title: 'Launch',
      purpose: 'Ship v1',
      memberBotIds: [alice, bob],
      moderatorBotId: bob,
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({ kind: 'group', title: 'Launch', purpose: 'Ship v1', moderatorBotId: bob });
    expect(body.members.map((m) => m.id)).toEqual([alice, bob]);
    const list = await app.inject({ method: 'GET', url: '/api/threads?kind=group' });
    expect(list.json<ThreadView[]>().map((t) => t.id)).toEqual([body.id]);

    expect((await create({ title: 'x', memberBotIds: [] })).status).toBe(400);
    expect((await create({ title: 'x', memberBotIds: ['bot_nope'] })).status).toBe(404);
    expect((await create({ title: 'x', memberBotIds: [alice], moderatorBotId: bob })).status).toBe(400);
  });

  it('adds and removes members with system messages; keeps at least one member', async () => {
    const g = (await create({ title: 'G', memberBotIds: [alice], moderatorBotId: alice })).body;
    const added = await app.inject({
      method: 'POST',
      url: `/api/threads/${g.id}/members`,
      payload: { botId: bob },
    });
    expect(added.json<ThreadView>().members.map((m) => m.id)).toEqual([alice, bob]);
    const removed = await app.inject({ method: 'DELETE', url: `/api/threads/${g.id}/members/${alice}` });
    expect(removed.json<ThreadView>()).toMatchObject({ moderatorBotId: null });
    expect(removed.json<ThreadView>().members.map((m) => m.id)).toEqual([bob]);
    const last = await app.inject({ method: 'DELETE', url: `/api/threads/${g.id}/members/${bob}` });
    expect(last.statusCode).toBe(409);
    const texts = h.repos.messages.listByThread(g.id).map((m) => `${m.authorType}: ${m.contentMd}`);
    expect(texts).toEqual(['system: Bob joined the group.', 'system: Alice left the group.']);
    // DMs have fixed members.
    const dm = h.repos.threads.findDm(alice)!.id;
    const bad = await app.inject({
      method: 'POST',
      url: `/api/threads/${dm}/members`,
      payload: { botId: bob },
    });
    expect(bad.statusCode).toBe(409);
  });

  it('a message mentioning two members starts a run for each; both reply', async () => {
    const g = (await create({ title: 'G', memberBotIds: [lead, alice, bob] })).body;
    const { message, runs } = await send(g.id, '@alice and @bob please look');
    expect(message.mentions).toEqual([alice, bob]);
    expect(runs.map((r) => [r.botId, r.trigger])).toEqual([
      [alice, 'user'],
      [bob, 'user'],
    ]);
    await h.service.idle();
    const replies = h.repos.messages.listByThread(g.id).filter((m) => m.authorType === 'bot');
    expect(replies.map((m) => m.authorBotId).sort()).toEqual([alice, bob].sort());
    // The echo quotes the prompt, so the mentions in it start nobody else.
    expect(h.repos.runs.list({ threadId: g.id })).toHaveLength(2);
  });

  it('without mentions the moderator answers: Agent A by default, the configured one otherwise', async () => {
    const g = (await create({ title: 'G', memberBotIds: [alice, lead, bob] })).body;
    expect((await send(g.id, 'anyone?')).runs.map((r) => r.botId)).toEqual([lead]);
    await app.inject({ method: 'PATCH', url: `/api/threads/${g.id}`, payload: { moderatorBotId: bob } });
    expect((await send(g.id, 'anyone else?')).runs.map((r) => r.botId)).toEqual([bob]);
    const noLead = (await create({ title: 'H', memberBotIds: [alice, bob] })).body;
    expect((await send(noLead.id, 'hi')).runs.map((r) => r.botId)).toEqual([alice]);
    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${g.id}`,
      payload: { moderatorBotId: 'x' },
    });
    expect(bad.statusCode).toBe(400);
    await h.service.idle();
  });

  it('the group prompt has the purpose, members with roles and the new messages', async () => {
    const g = (await create({ title: 'Launch', purpose: 'Ship v1', memberBotIds: [lead, alice] })).body;
    const { runs } = await send(g.id, 'status?');
    const prompt = h.repos.runs.get(runs[0]!.id)!.prompt;
    expect(prompt).toContain('## About #Launch');
    expect(prompt).toContain('Purpose: Ship v1');
    expect(prompt).toContain('- Agent A (@agent-a): Lead AI Engineer [lead, moderator, you]');
    expect(prompt).toContain('- Alice (@alice): Frontend');
    expect(prompt).toContain('You moderate this group');
    expect(prompt).toContain('## New messages in #Launch since your last turn');
    await h.service.idle();
    // Alice's first turn later sees what was said since (her last-seen marker is unset: only the new message).
    const next = await send(g.id, '@alice your turn');
    const p2 = h.repos.runs.get(next.runs[0]!.id)!.prompt;
    expect(p2).toContain('@alice your turn');
    expect(p2).not.toContain('You moderate this group');
    await h.service.idle();
  });

  it('the moderator delegates with ask_bot ([mock:moderate])', async () => {
    const g = (await create({ title: 'G', memberBotIds: [lead, alice] })).body;
    await send(g.id, 'build the login page [mock:moderate]');
    await h.service.idle();
    const runs = h.repos.runs.list({ threadId: g.id });
    const delegated = runs.find((r) => r.botId === alice)!;
    expect(delegated).toMatchObject({ trigger: 'delegation', hopCount: 1, status: 'succeeded' });
    const msgs = h.repos.messages.listByThread(g.id);
    expect(msgs.some((m) => m.authorBotId === lead && m.contentMd === 'Could you take this one?')).toBe(true);
    expect(
      msgs.some((m) => m.authorBotId === alice && m.authorType === 'bot' && m.runId === delegated.id),
    ).toBe(true);
  });

  it("a bot reply mentioning a member starts that member's turn, never its own, and stops at the hop limit", async () => {
    const g = (await create({ title: 'G', memberBotIds: [alice, bob] })).body;
    const msg = h.repos.messages.create({
      threadId: g.id,
      authorType: 'bot',
      authorBotId: alice,
      contentMd: '@bob can you check? (and @alice notes to self)',
    });
    const parent = h.repos.runs.create({
      botId: alice,
      threadId: g.id,
      trigger: 'user',
      prompt: 'x',
      engine: 'mock',
    });
    const routed = threads.routeBotMessage(msg, parent)!;
    expect(routed.mentions).toEqual([bob]);
    const triggered = h.repos.runs.list({ threadId: g.id, botId: bob });
    expect(triggered.map((r) => [r.trigger, r.hopCount, r.parentRunId])).toEqual([['mention', 1, parent.id]]);
    await h.service.idle();

    const deep = h.repos.runs.create({
      botId: alice,
      threadId: g.id,
      trigger: 'mention',
      prompt: 'x',
      engine: 'mock',
      hopCount: MAX_HOPS,
    });
    threads.routeBotMessage(msg, deep);
    expect(h.repos.runs.list({ threadId: g.id, botId: bob })).toHaveLength(1);
  });

  it('a finished reply that mentions a member is routed through onReply', async () => {
    const g = (await create({ title: 'G', memberBotIds: [alice, bob] })).body;
    // A single-line DM-style echo is not quoted: "You said: ping @bob" mentions bob.
    h.service.enqueue({ botId: alice, threadId: g.id, trigger: 'user', prompt: 'ping @bob' });
    await h.service.idle();
    const bobRuns = h.repos.runs.list({ threadId: g.id, botId: bob });
    expect(bobRuns.map((r) => [r.trigger, r.hopCount])).toEqual([['mention', 1]]);
  });

  // ---------- session 2: loop guards, pause, notifications ----------

  it('[mock:pingpong] stops at the hop limit with a system message', async () => {
    const g = (await create({ title: 'G', memberBotIds: [alice, bob] })).body;
    await send(g.id, '@alice start [mock:pingpong]');
    await h.service.idle();
    const runs = h.repos.runs.list({ threadId: g.id }).reverse();
    expect(runs.map((r) => r.hopCount)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(runs.map((r) => r.botId)).toEqual([alice, bob, alice, bob, alice, bob, alice]);
    const last = h.repos.messages.listByThread(g.id).at(-1)!;
    expect(last).toMatchObject({ authorType: 'system' });
    expect(last.contentMd).toContain('limit of 6 bot-to-bot turns');
  });

  it('the hop limit comes from the maxHopsPerMessage setting and also caps ask_bot', async () => {
    h.repos.settings.set('maxHopsPerMessage', 2);
    const g = (await create({ title: 'G', memberBotIds: [alice, bob] })).body;
    await send(g.id, '@alice go [mock:pingpong]');
    await h.service.idle();
    expect(h.repos.runs.list({ threadId: g.id })).toHaveLength(3);
    const deep = h.repos.runs.create({
      botId: alice,
      threadId: g.id,
      trigger: 'mention',
      prompt: 'x',
      engine: 'mock',
      hopCount: 2,
    });
    const a = h.repos.bots.get(alice)!;
    const b = h.repos.bots.get(bob)!;
    expect(() => threads.askBot(a, b, 'help', { threadId: g.id, parentRun: deep })).toThrow(/limit 2/);
  });

  it('a second trigger for a bot whose turn is still queued (within 5 s) is merged into it', async () => {
    const g = (await create({ title: 'G', memberBotIds: [alice, bob] })).body;
    const parent = h.repos.runs.create({
      botId: alice,
      threadId: g.id,
      trigger: 'user',
      prompt: 'x',
      engine: 'mock',
    });
    const say = (text: string) =>
      threads.routeBotMessage(
        h.repos.messages.create({ threadId: g.id, authorType: 'bot', authorBotId: alice, contentMd: text }),
        parent,
      );
    say('@bob first');
    say('@bob second');
    const bobRuns = h.repos.runs.list({ threadId: g.id, botId: bob });
    expect(bobRuns).toHaveLength(1);
    expect(bobRuns[0]!.prompt).toContain('@bob first');
    expect(bobRuns[0]!.prompt).toContain('## Also new since this turn was queued');
    expect(bobRuns[0]!.prompt).toContain('@bob second');
    await h.service.idle();
    // Once that turn has run, a new mention starts a new turn.
    say('@bob third');
    expect(h.repos.runs.list({ threadId: g.id, botId: bob })).toHaveLength(2);
    await h.service.idle();
  });

  it('pause cancels queued turns and stops bot mentions until the owner writes again', async () => {
    const g = (await create({ title: 'G', memberBotIds: [alice, bob] })).body;
    h.repos.settings.set('maxConcurrentRuns', 1);
    const sent = await send(g.id, '@alice @bob both [mock:slow]');
    const res = await app.inject({ method: 'POST', url: `/api/threads/${g.id}/pause` });
    expect(res.statusCode).toBe(200);
    expect(res.json<ThreadView>().pausedAt).not.toBeNull();
    const statuses = sent.runs.map((r) => h.repos.runs.get(r.id)!.status);
    expect(statuses).toContain('cancelled');
    const sys = h.repos.messages.listByThread(g.id).filter((m) => m.authorType === 'system');
    expect(sys.at(-1)!.contentMd).toMatch(/^Paused by the owner: \d queued turns? cancelled/);
    await Promise.all(h.service.activeRunIds().map((id) => h.service.cancel(id)));

    const msg = h.repos.messages.create({
      threadId: g.id,
      authorType: 'bot',
      authorBotId: alice,
      contentMd: '@bob hi',
    });
    threads.routeBotMessage(msg);
    expect(h.repos.runs.list({ threadId: g.id, botId: bob, status: 'queued' })).toHaveLength(0);
    expect(() =>
      threads.askBot(h.repos.bots.get(alice)!, h.repos.bots.get(bob)!, 'x', { threadId: g.id }),
    ).toThrow(/paused/);

    await send(g.id, '@alice back to work');
    expect(h.repos.threads.get(g.id)!.pausedAt).toBeNull();
    await h.service.idle();
    const resumed = await app.inject({ method: 'POST', url: `/api/threads/${g.id}/pause` });
    expect(resumed.statusCode).toBe(200);
    const r2 = await app.inject({ method: 'POST', url: `/api/threads/${g.id}/resume` });
    expect(r2.json<ThreadView>().pausedAt).toBeNull();
    const dm = h.repos.threads.findDm(alice)!.id;
    expect((await app.inject({ method: 'POST', url: `/api/threads/${dm}/pause` })).statusCode).toBe(409);
  });

  it('per-group notifications: mentions counts system and @owner messages, none mutes', async () => {
    const g = (await create({ title: 'G', memberBotIds: [alice] })).body;
    const bot = (contentMd: string) =>
      h.repos.messages.create({ threadId: g.id, authorType: 'bot', authorBotId: alice, contentMd });
    bot('just chatting');
    bot('@Owner please decide');
    h.repos.messages.create({ threadId: g.id, authorType: 'system', contentMd: 'note' });
    const unread = async () =>
      (await app.inject({ method: 'GET', url: '/api/threads/unread' })).json<{
        counts: Record<string, number>;
      }>().counts[g.id];
    expect(await unread()).toBe(3);
    const patch = (notifications: string) =>
      app.inject({ method: 'PATCH', url: `/api/threads/${g.id}`, payload: { notifications } });
    expect((await patch('mentions')).json<ThreadView>().notifications).toBe('mentions');
    expect(await unread()).toBe(2);
    await patch('none');
    expect(await unread()).toBeUndefined();
    expect((await patch('loud')).statusCode).toBe(400);
  });
});
