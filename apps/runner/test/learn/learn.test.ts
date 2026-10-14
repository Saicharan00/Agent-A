import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DecisionView, LessonView } from '@agenta/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { LearnService } from '../../src/learn/service';
import { buildServer } from '../../src/server';
import { type Harness, makeHarness, silent } from '../runs/helpers';

describe('learn: decisions and lessons (F23)', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const };
  let h: Harness;
  let now: Date;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let sharedDir: string;
  const events: unknown[] = [];

  beforeEach(async () => {
    h = makeHarness();
    sharedDir = join(h.dir, 'shared');
    now = new Date('2026-10-14T09:00:00.000Z');
    const learn = new LearnService({ repos: h.repos, bus: h.bus, log: silent, sharedDir, now: () => now });
    events.length = 0;
    h.bus.subscribe('global', (e) => events.push(e));
    app = await buildServer(config, { repos: h.repos, learn });
  });
  afterEach(async () => {
    await app.close();
    h.close();
  });

  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  const patch = (url: string, payload: object) => app.inject({ method: 'PATCH', url, payload });

  it('records a decision, exports it as ADR-0001-<slug>.md and re-exports on rename', async () => {
    const task = h.repos.tasks.create({ title: 'Pick a DB' });
    const res = await post('/api/decisions', {
      title: 'Use SQLite',
      contextMd: 'One user, one laptop.',
      optionsMd: '- SQLite\n- Postgres',
      decisionMd: 'SQLite.',
      taskId: task.id,
    });
    expect(res.statusCode).toBe(201);
    const d = res.json<DecisionView>();
    expect(d).toMatchObject({ number: 1, status: 'proposed', createdBy: 'user', taskId: task.id });
    expect(d.path).toBe('/shared/decisions/ADR-0001-use-sqlite.md');
    const file = join(sharedDir, 'decisions', 'ADR-0001-use-sqlite.md');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# ADR-0001: Use SQLite');
    expect(text).toContain('- Status: proposed');
    expect(text).toContain('## Options considered\n\n- SQLite\n- Postgres');
    expect(events).toContainEqual({ type: 'learn.changed', kind: 'decision', id: d.id });

    const upd = await patch(`/api/decisions/${d.id}`, { title: 'Use SQLite for v1', status: 'accepted' });
    expect(upd.json<DecisionView>()).toMatchObject({
      status: 'accepted',
      path: '/shared/decisions/ADR-0001-use-sqlite-for-v1.md',
    });
    expect(readdirSync(join(sharedDir, 'decisions'))).toEqual(['ADR-0001-use-sqlite-for-v1.md']);
    expect(existsSync(file)).toBe(false);

    const list = await app.inject({ url: `/api/decisions?status=accepted` });
    expect(list.json<DecisionView[]>().map((x) => x.id)).toEqual([d.id]);
    expect((await app.inject({ url: '/api/decisions/dec_nope' })).statusCode).toBe(404);
    expect((await post('/api/decisions', { title: 'x', taskId: 'tsk_nope' })).statusCode).toBe(404);
    expect((await post('/api/decisions', { title: '' })).json()).toMatchObject({
      error: { code: 'invalid_body' },
    });
  });

  it('lessons are due a day after creation and follow the 1d/3d/7d/21d review schedule', async () => {
    const res = await post('/api/lessons', {
      topic: 'Testing',
      lessonMd: 'Test the edges.',
      whyItMattersMd: 'Bugs live there.',
    });
    expect(res.statusCode).toBe(201);
    const l = res.json<LessonView>();
    expect(l).toMatchObject({ source: 'manual', reviewedCount: 0, nextReviewAt: '2026-10-15T09:00:00.000Z' });
    expect((await app.inject({ url: '/api/lessons?due=1' })).json()).toEqual([]);

    now = new Date('2026-10-15T09:00:00.000Z');
    expect((await app.inject({ url: '/api/lessons?due=1' })).json<LessonView[]>().map((x) => x.id)).toEqual([
      l.id,
    ]);
    const review = (result: string) =>
      post(`/api/lessons/${l.id}/review`, { result }).then((r) => r.json<LessonView>());
    expect(await review('got_it')).toMatchObject({
      reviewedCount: 1,
      nextReviewAt: '2026-10-16T09:00:00.000Z',
    });
    expect(await review('got_it')).toMatchObject({
      reviewedCount: 2,
      nextReviewAt: '2026-10-18T09:00:00.000Z',
    });
    expect(await review('again')).toMatchObject({
      reviewedCount: 0,
      nextReviewAt: '2026-10-16T09:00:00.000Z',
    });
    expect((await post(`/api/lessons/${l.id}/review`, { result: 'maybe' })).statusCode).toBe(400);

    expect((await patch(`/api/lessons/${l.id}`, { topic: 'QA' })).json()).toMatchObject({ topic: 'QA' });
    expect((await app.inject({ url: '/api/lessons?topic=QA' })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', url: `/api/lessons/${l.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/lessons/${l.id}` })).statusCode).toBe(404);
  });
});
