import { describe, expect, it } from 'vitest';
import { useTestDb } from './helpers';

describe('memoriesRepo', () => {
  const t = useTestDb();

  it('CRUD with scope and tag filters', () => {
    const b = t.repos.bots.create({ name: 'Dev', engine: 'mock' });
    const own = t.repos.memories.create({
      scope: 'bot',
      botId: b.id,
      title: 'Prefers pnpm',
      contentMd: 'x',
      tags: ['tooling'],
    });
    const shared = t.repos.memories.create({
      scope: 'shared',
      title: 'Repo layout',
      contentMd: 'y',
      tags: ['repo', 'tooling'],
    });
    expect(own.id).toMatch(/^mem_/);
    expect(t.repos.memories.list({ scope: 'shared' }).map((m) => m.id)).toEqual([shared.id]);
    expect(t.repos.memories.list({ botId: b.id }).map((m) => m.id)).toEqual([own.id]);
    expect(t.repos.memories.list({ tag: 'tooling' })).toHaveLength(2);
    expect(t.repos.memories.list({ tag: 'repo' }).map((m) => m.id)).toEqual([shared.id]);
    expect(t.repos.memories.list({ tag: 'missing' })).toEqual([]);

    expect(t.repos.memories.update(own.id, { tags: [] })?.tags).toEqual([]);
    expect(t.repos.memories.delete(shared.id)).toBe(true);
    expect(t.repos.memories.get(shared.id)).toBeUndefined();
  });

  it('enforces scope/botId consistency', () => {
    expect(() => t.repos.memories.create({ scope: 'bot', title: 'x', contentMd: 'x' })).toThrow();
    expect(() =>
      t.repos.memories.create({ scope: 'shared', botId: 'bot_x', title: 'x', contentMd: 'x' }),
    ).toThrow();
  });
});

describe('decisionsRepo', () => {
  const t = useTestDb();

  it('CRUD and filters', () => {
    const task = t.repos.tasks.create({ title: 'Pick a DB' });
    const d = t.repos.decisions.create({
      title: 'Use SQLite',
      taskId: task.id,
      optionsMd: '- SQLite\n- Postgres',
    });
    expect(d).toMatchObject({ status: 'proposed', createdBy: 'user' });
    expect(d.id).toMatch(/^dec_/);
    expect(t.repos.decisions.list({ taskId: task.id })).toHaveLength(1);
    expect(t.repos.decisions.update(d.id, { status: 'accepted', decisionMd: 'SQLite' })).toMatchObject({
      status: 'accepted',
      decisionMd: 'SQLite',
    });
    expect(t.repos.decisions.update(d.id, {})?.id).toBe(d.id);
    expect(t.repos.decisions.list({ status: 'proposed' })).toEqual([]);
    expect(t.repos.decisions.delete(d.id)).toBe(true);
  });
});

describe('lessonsRepo', () => {
  const t = useTestDb();

  it('CRUD, due list and review tracking', () => {
    const due = t.repos.lessons.create({
      topic: 'testing',
      lessonMd: 'Mock the engine',
      nextReviewAt: '2026-01-01T00:00:00.000Z',
    });
    const later = t.repos.lessons.create({
      topic: 'arch',
      lessonMd: 'Runs live in the runner',
      nextReviewAt: '2099-01-01T00:00:00.000Z',
    });
    t.repos.lessons.create({ topic: 'arch', lessonMd: 'never reviewed' });
    expect(due).toMatchObject({ source: 'manual', reviewedCount: 0 });
    expect(due.id).toMatch(/^lsn_/);
    expect(t.repos.lessons.listDue().map((l) => l.id)).toEqual([due.id]);
    expect(t.repos.lessons.list({ topic: 'arch' })).toHaveLength(2);

    const reviewed = t.repos.lessons.markReviewed(due.id, '2099-02-01T00:00:00.000Z');
    expect(reviewed).toMatchObject({ reviewedCount: 1, nextReviewAt: '2099-02-01T00:00:00.000Z' });
    expect(t.repos.lessons.listDue()).toEqual([]);
    expect(t.repos.lessons.update(later.id, { whyItMattersMd: 'because' })?.whyItMattersMd).toBe('because');
    expect(() => t.repos.lessons.update(later.id, { nextReviewAt: 'tomorrow' })).toThrow();
    expect(t.repos.lessons.delete(later.id)).toBe(true);
  });
});
