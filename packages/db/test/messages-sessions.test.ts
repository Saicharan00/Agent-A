import { describe, expect, it } from 'vitest';
import { sleep, useTestDb } from './helpers';

describe('messagesRepo', () => {
  const t = useTestDb();
  const setup = () => {
    const bot = t.repos.bots.create({ name: 'Echo', engine: 'mock' });
    const thread = t.repos.threads.create({ kind: 'dm', title: 'Echo', memberBotIds: [bot.id] });
    return { bot, thread };
  };

  it('creates user and bot messages and bumps the thread', async () => {
    const { bot, thread } = setup();
    await sleep(2);
    const m = t.repos.messages.create({
      threadId: thread.id,
      authorType: 'user',
      contentMd: 'hi @echo',
      mentions: [bot.id],
    });
    expect(m.id).toMatch(/^msg_/);
    expect(m).toMatchObject({ authorBotId: null, runId: null, mentions: [bot.id] });
    expect(t.repos.threads.get(thread.id)!.updatedAt).toBe(m.createdAt);

    const r = t.repos.messages.create({
      threadId: thread.id,
      authorType: 'bot',
      authorBotId: bot.id,
      contentMd: 'hi',
    });
    expect(t.repos.messages.get(r.id)?.authorBotId).toBe(bot.id);
  });

  it("finds a run's bot reply and updates its text", () => {
    const { bot, thread } = setup();
    const run = t.repos.runs.create({
      botId: bot.id,
      threadId: thread.id,
      trigger: 'user',
      engine: 'mock',
      prompt: 'x',
    });
    const ask = t.repos.messages.create({
      threadId: thread.id,
      authorType: 'user',
      contentMd: 'x',
      runId: run.id,
    });
    expect(t.repos.messages.getByRun(run.id)).toBeUndefined();
    const reply = t.repos.messages.create({
      threadId: thread.id,
      authorType: 'bot',
      authorBotId: bot.id,
      contentMd: 'part 1',
      runId: run.id,
    });
    expect(t.repos.messages.getByRun(run.id)?.id).toBe(reply.id);
    expect(t.repos.messages.updateContent(reply.id, 'part 1\n\npart 2')?.contentMd).toBe('part 1\n\npart 2');
    expect(t.repos.messages.get(ask.id)?.contentMd).toBe('x');
    expect(t.repos.messages.updateContent('msg_missing', 'y')).toBeUndefined();
  });

  it('validates author consistency', () => {
    const { bot, thread } = setup();
    expect(() =>
      t.repos.messages.create({ threadId: thread.id, authorType: 'bot', contentMd: 'x' }),
    ).toThrow();
    expect(() =>
      t.repos.messages.create({
        threadId: thread.id,
        authorType: 'user',
        authorBotId: bot.id,
        contentMd: 'x',
      }),
    ).toThrow();
  });

  it('pages history chronologically and lists messages since a cursor', () => {
    const { thread } = setup();
    // Many inserts land in the same millisecond: ordering must still be insertion order.
    const ids = Array.from(
      { length: 7 },
      (_, i) => t.repos.messages.create({ threadId: thread.id, authorType: 'user', contentMd: `m${i}` }).id,
    );
    expect(t.repos.messages.listByThread(thread.id).map((m) => m.id)).toEqual(ids);
    expect(t.repos.messages.listByThread(thread.id, { limit: 3 }).map((m) => m.id)).toEqual(ids.slice(4));
    expect(t.repos.messages.listByThread(thread.id, { before: ids[4], limit: 3 }).map((m) => m.id)).toEqual(
      ids.slice(1, 4),
    );
    expect(t.repos.messages.listByThread(thread.id, { before: 'msg_missing' })).toEqual([]);
    expect(t.repos.messages.listSince(thread.id, ids[4]!).map((m) => m.id)).toEqual(ids.slice(5));
    expect(t.repos.messages.listSince(thread.id, null)).toHaveLength(7);
    expect(t.repos.messages.latest(thread.id)?.id).toBe(ids[6]);
  });

  it('links a run and deletes', () => {
    const { bot, thread } = setup();
    const m = t.repos.messages.create({ threadId: thread.id, authorType: 'user', contentMd: 'x' });
    const run = t.repos.runs.create({
      botId: bot.id,
      threadId: thread.id,
      trigger: 'user',
      engine: 'mock',
      prompt: 'x',
    });
    expect(t.repos.messages.setRunId(m.id, run.id)?.runId).toBe(run.id);
    expect(t.repos.messages.delete(m.id)).toBe(true);
    expect(t.repos.messages.get(m.id)).toBeUndefined();
  });

  it('is removed with its thread', () => {
    const { thread } = setup();
    const m = t.repos.messages.create({ threadId: thread.id, authorType: 'user', contentMd: 'x' });
    t.repos.threads.delete(thread.id);
    expect(t.repos.messages.get(m.id)).toBeUndefined();
  });
});

describe('sessionsRepo', () => {
  const t = useTestDb();

  it('upserts one session per (bot, thread), keeping omitted fields', () => {
    const bot = t.repos.bots.create({ name: 'Echo', engine: 'claude' });
    const thread = t.repos.threads.create({ kind: 'dm', title: 'Echo', memberBotIds: [bot.id] });
    expect(t.repos.sessions.get(bot.id, thread.id)).toBeUndefined();

    const s1 = t.repos.sessions.upsert({
      botId: bot.id,
      threadId: thread.id,
      engine: 'claude',
      engineSessionId: 'sess-1',
    });
    expect(s1).toMatchObject({ engineSessionId: 'sess-1', lastSeenMessageId: null });

    const s2 = t.repos.sessions.upsert({
      botId: bot.id,
      threadId: thread.id,
      engine: 'claude',
      lastSeenMessageId: 'msg_x',
    });
    expect(s2).toMatchObject({ engineSessionId: 'sess-1', lastSeenMessageId: 'msg_x' });
    expect(t.repos.sessions.listByBot(bot.id)).toHaveLength(1);

    expect(t.repos.sessions.delete(bot.id, thread.id)).toBe(true);
    expect(t.repos.sessions.get(bot.id, thread.id)).toBeUndefined();
    t.repos.sessions.upsert({ botId: bot.id, threadId: thread.id, engine: 'codex' });
    expect(t.repos.sessions.deleteByBot(bot.id)).toBe(1);
  });
});
