import { describe, expect, it } from 'vitest';
import { useTestDb } from './helpers';

describe('approvalsRepo', () => {
  const t = useTestDb();

  it('creates pending approvals and decides once', () => {
    const b = t.repos.bots.create({ name: 'Ops', engine: 'mock' });
    const a = t.repos.approvals.create({ botId: b.id, action: 'git push', risk: 'high' });
    expect(a).toMatchObject({ status: 'pending', decidedAt: null, risk: 'high' });
    expect(a.id).toMatch(/^apr_/);
    expect(t.repos.approvals.list({ status: 'pending' })).toHaveLength(1);
    expect(t.repos.approvals.decide(a.id, { status: 'approved' })?.status).toBe('approved');
    expect(t.repos.approvals.decide(a.id, { status: 'denied' })).toBeUndefined();
    expect(() => t.repos.approvals.decide(a.id, { status: 'pending' as never })).toThrow();

    t.repos.approvals.create({ botId: b.id, action: 'send email' });
    expect(t.repos.approvals.expireOlderThan('2999-01-01T00:00:00.000Z')).toBe(1);
    expect(t.repos.approvals.list({ status: 'expired' })).toHaveLength(1);
    expect(t.repos.approvals.list({ botId: b.id })).toHaveLength(2);
    expect(t.repos.approvals.delete(a.id)).toBe(true);
  });
});

describe('schedulesRepo', () => {
  const t = useTestDb();

  it('CRUD and due list', () => {
    const b = t.repos.bots.create({ name: 'Sched', engine: 'mock' });
    const s = t.repos.schedules.create({
      name: 'Daily standup',
      botId: b.id,
      cron: '0 9 * * 1-5',
      prompt: 'Summarise yesterday',
      nextRunAt: '2026-01-01T09:00:00.000Z',
    });
    expect(s).toMatchObject({ enabled: true, catchUp: false, timezone: 'America/New_York' });
    expect(s.id).toMatch(/^sch_/);
    expect(t.repos.schedules.listDue().map((x) => x.id)).toEqual([s.id]);
    t.repos.schedules.update(s.id, { enabled: false });
    expect(t.repos.schedules.listDue()).toEqual([]);
    expect(t.repos.schedules.list({ enabled: false })).toHaveLength(1);
    expect(t.repos.schedules.list({ botId: b.id })).toHaveLength(1);
    expect(t.repos.schedules.update(s.id, {})?.id).toBe(s.id);
    expect(t.repos.schedules.delete(s.id)).toBe(true);
  });
});

describe('notificationsRepo', () => {
  const t = useTestDb();

  it('creates, counts and marks read', () => {
    const n1 = t.repos.notifications.create({ kind: 'run.finished', title: 'Run done', link: '/runs/1' });
    t.repos.notifications.create({ kind: 'approval', title: 'Approve?' });
    expect(n1.id).toMatch(/^ntf_/);
    expect(t.repos.notifications.countUnread()).toBe(2);
    expect(t.repos.notifications.markRead(n1.id)?.readAt).not.toBeNull();
    expect(t.repos.notifications.markRead(n1.id)).toBeUndefined();
    expect(t.repos.notifications.list({ unreadOnly: true })).toHaveLength(1);
    expect(t.repos.notifications.markAllRead()).toBe(1);
    expect(t.repos.notifications.countUnread()).toBe(0);
    expect(t.repos.notifications.list()).toHaveLength(2);
    expect(t.repos.notifications.get(n1.id)?.title).toBe('Run done');
    expect(t.repos.notifications.delete(n1.id)).toBe(true);
  });
});

describe('engineStateRepo', () => {
  const t = useTestDb();

  it('upserts limit state per engine', () => {
    expect(t.repos.engineState.get('claude')).toBeUndefined();
    expect(t.repos.engineState.isLimited('claude')).toBe(false);
    t.repos.engineState.upsert('claude', {
      limitedUntil: '2999-01-01T00:00:00.000Z',
      lastError: 'usage limit',
    });
    expect(t.repos.engineState.isLimited('claude')).toBe(true);
    expect(t.repos.engineState.isLimited('codex')).toBe(false);
    const cleared = t.repos.engineState.clearLimit('claude');
    expect(cleared).toMatchObject({ limitedUntil: null, lastError: 'usage limit' });
    t.repos.engineState.upsert('codex', { lastError: null });
    expect(t.repos.engineState.list().map((e) => e.engine)).toEqual(['claude', 'codex']);
  });
});

describe('connectorsRepo', () => {
  const t = useTestDb();

  it('CRUD and bot attachments', () => {
    const b = t.repos.bots.create({ name: 'Dev', engine: 'mock' });
    const c = t.repos.connectors.create({ type: 'github', config: { owner: 'me' } });
    expect(c).toMatchObject({ enabled: true, config: { owner: 'me' } });
    expect(c.id).toMatch(/^con_/);
    t.repos.connectors.attach(b.id, c.id);
    t.repos.connectors.attach(b.id, c.id);
    expect(t.repos.connectors.listForBot(b.id).map((x) => x.id)).toEqual([c.id]);
    expect(t.repos.connectors.update(c.id, { enabled: false })?.enabled).toBe(false);
    expect(t.repos.connectors.detach(b.id, c.id)).toBe(true);
    expect(t.repos.connectors.listForBot(b.id)).toEqual([]);
    expect(t.repos.connectors.list()).toHaveLength(1);
    expect(t.repos.connectors.delete(c.id)).toBe(true);
    expect(t.repos.connectors.get(c.id)).toBeUndefined();
  });
});

describe('guardTermsRepo', () => {
  const t = useTestDb();

  it('CRUD and regex validation', () => {
    const g = t.repos.guardTerms.create({ term: 'Project Falcon', note: 'client codename' });
    expect(g).toMatchObject({ kind: 'literal' });
    expect(g.id).toMatch(/^grd_/);
    t.repos.guardTerms.create({ term: 'ACME-\\d+', kind: 'regex' });
    expect(() => t.repos.guardTerms.create({ term: '([', kind: 'regex' })).toThrow();
    expect(t.repos.guardTerms.list()).toHaveLength(2);
    expect(t.repos.guardTerms.get(g.id)?.term).toBe('Project Falcon');
    expect(t.repos.guardTerms.delete(g.id)).toBe(true);
  });
});

describe('settingsRepo', () => {
  const t = useTestDb();

  it('stores JSON values by key', () => {
    expect(t.repos.settings.get('maxConcurrentRuns')).toBeUndefined();
    t.repos.settings.set('maxConcurrentRuns', 2);
    t.repos.settings.set('ui.theme', { mode: 'dark' });
    t.repos.settings.set('maxConcurrentRuns', 3);
    expect(t.repos.settings.get<number>('maxConcurrentRuns')).toBe(3);
    expect(t.repos.settings.all()).toEqual({ maxConcurrentRuns: 3, 'ui.theme': { mode: 'dark' } });
    expect(() => t.repos.settings.set('Bad Key', 1)).toThrow();
    expect(() => t.repos.settings.set('x', undefined)).toThrow();
    expect(t.repos.settings.delete('ui.theme')).toBe(true);
    expect(t.repos.settings.delete('ui.theme')).toBe(false);
  });
});
