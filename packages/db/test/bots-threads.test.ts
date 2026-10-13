import { describe, expect, it } from 'vitest';
import { slugify } from '../src/index';
import { sleep, useTestDb } from './helpers';

describe('botsRepo', () => {
  const t = useTestDb();

  it('creates with defaults, prefixed id and derived slug', () => {
    const bot = t.repos.bots.create({ name: 'Code Reviewer', engine: 'claude' });
    expect(bot.id).toMatch(/^bot_[A-Za-z0-9]{16}$/);
    expect(bot).toMatchObject({
      slug: 'code-reviewer',
      status: 'stopped',
      isLead: false,
      avatarShape: 'circle',
      sidebarVisible: true,
      notifications: 'all',
      model: null,
      settings: { cpus: 2, memoryMb: 2048, idleTimeoutMin: 30, flags: {} },
    });
    expect(bot.createdAt).toBe(bot.updatedAt);
    expect(new Date(bot.createdAt).toISOString()).toBe(bot.createdAt);
  });

  it('keeps slugs unique', () => {
    const a = t.repos.bots.create({ name: 'Writer', engine: 'mock' });
    const b = t.repos.bots.create({ name: 'Writer', engine: 'mock' });
    const c = t.repos.bots.create({ name: 'Writer!', engine: 'mock' });
    expect([a.slug, b.slug, c.slug]).toEqual(['writer', 'writer-2', 'writer-3']);
    expect(() => t.repos.bots.update(b.id, { slug: 'writer' })).toThrow(/taken/);
  });

  it('rejects invalid input', () => {
    expect(() => t.repos.bots.create({ name: '', engine: 'mock' })).toThrow();
    // @ts-expect-error invalid engine
    expect(() => t.repos.bots.create({ name: 'x', engine: 'gpt' })).toThrow();
    expect(() => t.repos.bots.create({ name: 'x', engine: 'mock', avatarColor: 'red' })).toThrow();
  });

  it('gets, lists, updates, archives and deletes', async () => {
    const bot = t.repos.bots.create({ name: 'Agent A', engine: 'claude', isLead: true });
    const other = t.repos.bots.create({ name: 'Helper', engine: 'codex' });
    expect(t.repos.bots.get(bot.id)?.name).toBe('Agent A');
    expect(t.repos.bots.getBySlug('helper')?.id).toBe(other.id);
    expect(t.repos.bots.getLead()?.id).toBe(bot.id);
    expect(t.repos.bots.get('bot_nope')).toBeUndefined();

    await sleep(2);
    const updated = t.repos.bots.update(bot.id, { role: 'Lead', model: 'opus', settings: { cpus: 4 } });
    expect(updated).toMatchObject({ role: 'Lead', model: 'opus', name: 'Agent A' });
    expect(updated?.settings.cpus).toBe(4);
    expect(updated?.settings.memoryMb).toBe(2048);
    expect(updated!.updatedAt > bot.updatedAt).toBe(true);
    expect(t.repos.bots.update('bot_nope', { role: 'x' })).toBeUndefined();

    const rt = t.repos.bots.updateRuntime(bot.id, {
      status: 'running',
      containerId: 'abc',
      novncPort: 41000,
    });
    expect(rt).toMatchObject({ status: 'running', containerId: 'abc', novncPort: 41000 });

    t.repos.bots.archive(other.id);
    expect(t.repos.bots.list().map((b) => b.id)).toEqual([bot.id]);
    expect(t.repos.bots.list({ includeArchived: true })).toHaveLength(2);
    t.repos.bots.unarchive(other.id);
    expect(t.repos.bots.list()).toHaveLength(2);

    expect(t.repos.bots.delete(other.id)).toBe(true);
    expect(t.repos.bots.delete(other.id)).toBe(false);
    expect(t.repos.bots.get(other.id)).toBeUndefined();
  });

  it('slugify handles odd names', () => {
    expect(slugify('  Ünïcode Bot!! ')).toBe('unicode-bot');
    expect(slugify('!!!')).toBe('bot');
  });
});

describe('threadsRepo', () => {
  const t = useTestDb();

  it('creates with members, finds DMs, manages membership', () => {
    const a = t.repos.bots.create({ name: 'A', engine: 'mock' });
    const b = t.repos.bots.create({ name: 'B', engine: 'mock' });
    const dm = t.repos.threads.create({ kind: 'dm', title: 'A', memberBotIds: [a.id, a.id] });
    expect(dm.id).toMatch(/^thr_/);
    expect(dm.explainMode).toBe(false);
    expect(t.repos.threads.listMembers(dm.id).map((x) => x.id)).toEqual([a.id]);
    expect(t.repos.threads.findDm(a.id)?.id).toBe(dm.id);
    expect(t.repos.threads.findDm(b.id)).toBeUndefined();

    const group = t.repos.threads.create({ kind: 'group', title: 'Team', memberBotIds: [a.id] });
    expect(t.repos.threads.addMember(group.id, b.id)).toBe(true);
    expect(t.repos.threads.addMember(group.id, b.id)).toBe(false);
    expect(t.repos.threads.isMember(group.id, b.id)).toBe(true);
    expect(t.repos.threads.listMembers(group.id).map((x) => x.id)).toEqual([a.id, b.id]);
    expect(t.repos.threads.removeMember(group.id, b.id)).toBe(true);
    expect(t.repos.threads.isMember(group.id, b.id)).toBe(false);

    expect(t.repos.threads.list({ kind: 'group' }).map((x) => x.id)).toEqual([group.id]);
    expect(t.repos.threads.list({ botId: a.id })).toHaveLength(2);
    expect(t.repos.threads.list({ botId: b.id })).toHaveLength(0);
  });

  it('rejects members that are not bots', () => {
    expect(() => t.repos.threads.create({ kind: 'group', title: 'x', memberBotIds: ['bot_nope'] })).toThrow(
      /FOREIGN KEY/,
    );
    // The transaction rolled back: no orphan thread.
    expect(t.repos.threads.list({ includeArchived: true })).toHaveLength(0);
  });

  it('updates, sorts by activity, archives and deletes (cascading members)', async () => {
    const bot = t.repos.bots.create({ name: 'A', engine: 'mock' });
    const one = t.repos.threads.create({ kind: 'group', title: 'One', memberBotIds: [bot.id] });
    await sleep(2);
    const two = t.repos.threads.create({ kind: 'group', title: 'Two' });
    expect(t.repos.threads.list().map((x) => x.id)).toEqual([two.id, one.id]);
    await sleep(2);
    t.repos.threads.touch(one.id);
    expect(t.repos.threads.list().map((x) => x.id)).toEqual([one.id, two.id]);

    expect(t.repos.threads.update(one.id, { title: 'Renamed', explainMode: true })).toMatchObject({
      title: 'Renamed',
      explainMode: true,
    });
    t.repos.threads.archive(two.id);
    expect(t.repos.threads.list().map((x) => x.id)).toEqual([one.id]);
    expect(t.repos.threads.get(two.id)?.archivedAt).not.toBeNull();

    expect(t.repos.threads.delete(one.id)).toBe(true);
    expect(t.repos.threads.listMembers(one.id)).toEqual([]);
    expect(t.repos.bots.get(bot.id)).toBeDefined();
  });

  it('cascades memberships when a bot is deleted', () => {
    const bot = t.repos.bots.create({ name: 'A', engine: 'mock' });
    const thr = t.repos.threads.create({ kind: 'dm', title: 'A', memberBotIds: [bot.id] });
    t.repos.bots.delete(bot.id);
    expect(t.repos.threads.listMembers(thr.id)).toEqual([]);
  });
});

describe('thread read markers', () => {
  const ctx = useTestDb();

  it('counts messages from bots and the system after the last read, per thread', () => {
    const { repos } = ctx;
    {
      const bot = repos.bots.create({ name: 'R', slug: 'r', engine: 'mock' });
      const t = repos.threads.create({ kind: 'dm', title: 'R', memberBotIds: [bot.id] });
      const other = repos.threads.create({ kind: 'dm', title: 'O' });
      repos.messages.create({ threadId: t.id, authorType: 'user', contentMd: 'hi' });
      repos.messages.create({ threadId: t.id, authorType: 'bot', authorBotId: bot.id, contentMd: 'a' });
      repos.messages.create({ threadId: t.id, authorType: 'system', contentMd: 'note' });
      expect(repos.threads.unreadCounts()).toEqual({ [t.id]: 2 });
      expect(other.lastReadAt).toBeNull();

      const later = new Date(Date.now() + 1000).toISOString();
      expect(repos.threads.markRead(t.id, later)?.lastReadAt).toBe(later);
      expect(repos.threads.unreadCounts()).toEqual({});
      // Never moves backwards.
      expect(repos.threads.markRead(t.id, '2000-01-01T00:00:00.000Z')).toBeUndefined();
      expect(repos.threads.get(t.id)?.lastReadAt).toBe(later);

      repos.threads.archive(t.id);
      repos.messages.create({ threadId: t.id, authorType: 'bot', authorBotId: bot.id, contentMd: 'b' });
      expect(repos.threads.unreadCounts()).toEqual({});
    }
  });
});
