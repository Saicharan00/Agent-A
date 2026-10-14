import type { LiveNotificationChanged, NotificationListResponse } from '@agenta/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { PlatformTools } from '../../src/mcp/tools';
import { NotificationService, asksOwner, notify } from '../../src/notifications/service';
import { buildServer } from '../../src/server';
import { type Harness, makeHarness, silent } from '../runs/helpers';

describe('notifications (F27)', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const };
  let h: Harness;
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    h = makeHarness();
    app = await buildServer(config, {
      repos: h.repos,
      notifications: new NotificationService({ repos: h.repos, bus: h.bus }),
    });
  });
  afterEach(async () => {
    await app.close();
    h.close();
  });

  const live = () =>
    h.published
      .map((p) => p.event)
      .filter((e): e is LiveNotificationChanged => e.type === 'notification.changed');
  const inbox = async (q = '') =>
    (await app.inject({ url: `/api/notifications${q}` })).json<NotificationListResponse>();

  /** Runs one turn on the gate engine in a fresh DM and returns the thread id. */
  async function turn(
    text: string,
    opts: { trigger?: 'user' | 'mention' | 'schedule'; error?: boolean } = {},
  ) {
    const botId = h.bot('Ada', 'claude');
    const threadId = h.dm(botId);
    h.service.enqueue({ botId, threadId, trigger: opts.trigger ?? 'user', prompt: text });
    await h.gate.whenRunning(1);
    h.gate.release(text, opts.error ? [{ type: 'error', message: 'boom' }] : [{ type: 'text.final', text }]);
    await h.service.idle();
    return { botId, threadId };
  }

  it('asksOwner: the last paragraph ends with a question', () => {
    expect(asksOwner('Done.\n\nShould I push it?')).toBe(true);
    expect(asksOwner('Shall I go on?**')).toBe(true);
    expect(asksOwner('Why? Because.\n\nAll done.')).toBe(false);
    expect(asksOwner('')).toBe(false);
  });

  it('notify stores, pushes live and sets desktop from the bot setting', () => {
    const all = h.repos.bots.create({ name: 'All', engine: 'mock' });
    const quiet = h.repos.bots.create({ name: 'Quiet', engine: 'mock', notifications: 'mentions' });
    const mute = h.repos.bots.create({ name: 'Mute', engine: 'mock', notifications: 'none' });
    notify(h.repos, h.bus, { kind: 'run.finished', title: 'a', botId: all.id });
    notify(h.repos, h.bus, { kind: 'run.finished', title: 'b', botId: quiet.id });
    notify(h.repos, h.bus, { kind: 'bot.question', title: 'c', botId: quiet.id });
    notify(h.repos, h.bus, { kind: 'bot.question', title: 'd', botId: mute.id });
    notify(h.repos, h.bus, { kind: 'engine.resumed', title: 'e' });
    expect(live().map((e) => [e.notification?.title, e.desktop])).toEqual([
      ['a', true],
      ['b', false],
      ['c', true],
      ['d', false],
      ['e', true],
    ]);
    expect(h.repos.notifications.countUnread()).toBe(5);
  });

  it('a finished run in a thread nobody watches creates an unread notification linking to it', async () => {
    const { botId, threadId } = await turn('All done.');
    const { items, unread } = await inbox();
    expect(unread).toBe(1);
    expect(items[0]).toMatchObject({
      kind: 'run.finished',
      title: 'Ada finished',
      body: 'All done.',
      link: `/threads/${threadId}`,
      botId,
      readAt: null,
    });
  });

  it('no notification while the owner watches the thread', async () => {
    const botId = h.bot('Ada', 'claude');
    const threadId = h.dm(botId);
    const off = h.bus.subscribe(`thread:${threadId}`, () => undefined);
    h.service.enqueue({ botId, threadId, trigger: 'user', prompt: 'x' });
    await h.gate.whenRunning(1);
    h.gate.release('x');
    await h.service.idle();
    off();
    expect((await inbox()).items).toHaveLength(0);
  });

  it('questions, failures, bot-to-bot mentions and failed schedules', async () => {
    await turn('Which branch should I use?');
    await turn('fails', { error: true });
    await turn('just chatting', { trigger: 'mention' });
    await turn('sched', { trigger: 'schedule', error: true });
    const kinds = (await inbox()).items.map((n) => n.kind);
    expect(kinds.sort()).toEqual(['bot.question', 'run.failed', 'schedule.failed']);
  });

  it('blocked and handed-in tasks (outside a goal) notify the owner', async () => {
    const tools = new PlatformTools({
      repos: h.repos,
      bus: h.bus,
      threads: { postAsBot: () => undefined, askBot: () => undefined } as never,
      log: silent,
    });
    const bot = h.repos.bots.create({ name: 'Dev', engine: 'mock' });
    const task = h.repos.tasks.create({ title: 'Fix login', createdBy: 'user', assigneeBotId: bot.id });
    await tools.call(bot, 'update_task', { id: task.id, status: 'blocked', note: 'need a token' });
    await tools.call(bot, 'submit_task_result', { id: task.id, summary: 'fixed' });
    expect((await inbox()).items.map((n) => [n.kind, n.title])).toEqual([
      ['task.review', 'Ready for your review: Fix login'],
      ['task.blocked', 'Dev is blocked: Fix login'],
    ]);
  });

  it('read, read-all and the unread filter', async () => {
    const a = notify(h.repos, h.bus, { kind: 'x', title: 'a' });
    notify(h.repos, h.bus, { kind: 'x', title: 'b' });
    const res = await app.inject({ method: 'POST', url: `/api/notifications/${a.id}/read` });
    expect(res.json().readAt).toEqual(expect.any(String));
    expect(live().at(-1)).toEqual({ type: 'notification.changed', notification: null, desktop: false });
    expect((await inbox('?unread=1')).items.map((n) => n.title)).toEqual(['b']);
    await app.inject({ method: 'POST', url: '/api/notifications/read-all' });
    expect(await inbox('?unread=1')).toEqual({ items: [], unread: 0 });
    expect((await app.inject({ method: 'POST', url: '/api/notifications/nope/read' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/notifications?limit=0' })).statusCode).toBe(400);
  });
});
