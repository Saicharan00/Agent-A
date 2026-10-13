import { describe, expect, it } from 'vitest';
import { sleep, useTestDb } from './helpers';

describe('runsRepo', () => {
  const t = useTestDb();
  const bot = () => t.repos.bots.create({ name: 'Echo', engine: 'mock' });

  it('creates queued runs and walks the lifecycle', async () => {
    const b = bot();
    const run = t.repos.runs.create({ botId: b.id, trigger: 'user', engine: 'mock', prompt: 'hello' });
    expect(run).toMatchObject({ status: 'queued', hopCount: 0, threadId: null, startedAt: null });
    expect(run.id).toMatch(/^run_/);

    const running = t.repos.runs.markRunning(run.id);
    expect(running?.status).toBe('running');
    expect(t.repos.runs.markRunning(run.id)).toBeUndefined();
    await sleep(5);

    const done = t.repos.runs.finish(run.id, {
      status: 'succeeded',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(done).toMatchObject({ status: 'succeeded', usage: { inputTokens: 10, outputTokens: 5 } });
    expect(done!.durationMs).toBeGreaterThanOrEqual(1);
    expect(t.repos.runs.finish(run.id, { status: 'failed' })).toBeUndefined();

    expect(t.repos.runs.requeue(run.id)).toMatchObject({
      status: 'queued',
      startedAt: null,
      durationMs: null,
    });
    expect(t.repos.runs.delete(run.id)).toBe(true);
    expect(t.repos.runs.get(run.id)).toBeUndefined();
  });

  it('queues FIFO per engine and filters lists', async () => {
    const b = bot();
    const first = t.repos.runs.create({ botId: b.id, trigger: 'user', engine: 'mock', prompt: '1' });
    await sleep(2);
    const second = t.repos.runs.create({ botId: b.id, trigger: 'task', engine: 'claude', prompt: '2' });
    expect(t.repos.runs.nextQueued()?.id).toBe(first.id);
    expect(t.repos.runs.nextQueued('claude')?.id).toBe(second.id);
    expect(t.repos.runs.nextQueued('codex')).toBeUndefined();
    expect(t.repos.runs.countByStatus('queued')).toBe(2);
    expect(t.repos.runs.countByStatus('queued', 'claude')).toBe(1);

    t.repos.runs.markRunning(first.id);
    t.repos.runs.finish(first.id, { status: 'failed', error: 'boom' });
    expect(t.repos.runs.list({ status: 'failed' }).map((r) => r.id)).toEqual([first.id]);
    expect(t.repos.runs.list({ status: ['failed', 'queued'] }).map((r) => r.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(t.repos.runs.list({ botId: b.id, limit: 1 })).toHaveLength(1);
    expect(t.repos.runs.get(first.id)?.error).toBe('boom');
  });

  it('keeps FIFO order for runs created in the same millisecond', () => {
    const b = bot();
    const ids = Array.from(
      { length: 6 },
      (_, i) => t.repos.runs.create({ botId: b.id, trigger: 'user', engine: 'mock', prompt: String(i) }).id,
    );
    expect(t.repos.runs.nextQueued()?.id).toBe(ids[0]);
    expect(t.repos.runs.list().map((r) => r.id)).toEqual([...ids].reverse());
  });

  it('appends events with per-run sequence numbers and replays after a seq', () => {
    const b = bot();
    const r1 = t.repos.runs.create({ botId: b.id, trigger: 'user', engine: 'mock', prompt: 'x' });
    const r2 = t.repos.runs.create({
      botId: b.id,
      trigger: 'user',
      engine: 'mock',
      prompt: 'y',
      parentRunId: r1.id,
      hopCount: 1,
    });
    t.repos.runs.appendEvent(r1.id, 'run.started', { type: 'run.started', engine: 'mock' });
    t.repos.runs.appendEvent(r1.id, 'text.delta', { type: 'text.delta', text: 'hi' });
    t.repos.runs.appendEvent(r2.id, 'run.started', { type: 'run.started', engine: 'mock' });
    const e3 = t.repos.runs.appendEvent(r1.id, 'run.finished', { type: 'run.finished', status: 'succeeded' });
    expect(e3.seq).toBe(3);
    expect(t.repos.runs.listEvents(r1.id).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(t.repos.runs.listEvents(r1.id, 1).map((e) => e.type)).toEqual(['text.delta', 'run.finished']);
    expect(t.repos.runs.listEvents(r1.id, 1)[0]?.payload).toEqual({ type: 'text.delta', text: 'hi' });
    expect(t.repos.runs.listEvents(r2.id)).toHaveLength(1);

    t.repos.runs.delete(r1.id);
    expect(t.repos.runs.listEvents(r1.id)).toEqual([]);
    expect(t.repos.runs.get(r2.id)?.parentRunId).toBeNull();
  });

  it('appends event batches after the last seq, counts events and lists the queue FIFO', () => {
    const b = bot();
    const r = t.repos.runs.create({ botId: b.id, trigger: 'user', engine: 'mock', prompt: 'x' });
    expect(t.repos.runs.appendEvents(r.id, [])).toEqual([]);
    t.repos.runs.appendEvent(r.id, 'run.started', { type: 'run.started', engine: 'mock' });
    const rows = t.repos.runs.appendEvents(r.id, [
      { type: 'text.delta', payload: { type: 'text.delta', text: 'a' } },
      { type: 'limit.hit', payload: { type: 'limit.hit', engine: 'mock', raw: 'x' } },
    ]);
    expect(rows.map((e) => e.seq)).toEqual([2, 3]);
    expect(t.repos.runs.countEvents(r.id, 'limit.hit')).toBe(1);
    expect(t.repos.runs.countEvents(r.id, 'error')).toBe(0);

    const r2 = t.repos.runs.create({ botId: b.id, trigger: 'user', engine: 'mock', prompt: 'y' });
    const r3 = t.repos.runs.create({ botId: b.id, trigger: 'user', engine: 'mock', prompt: 'z' });
    t.repos.runs.markRunning(r2.id);
    expect(t.repos.runs.listQueued().map((q) => q.id)).toEqual([r.id, r3.id]);
  });
});

describe('tasksRepo', () => {
  const t = useTestDb();

  it('creates, filters, updates, records events and deletes', async () => {
    const b = t.repos.bots.create({ name: 'Dev', engine: 'mock' });
    const parent = t.repos.tasks.create({ title: 'Build feature', assigneeBotId: b.id, priority: 'p1' });
    expect(parent).toMatchObject({
      status: 'todo',
      priority: 'p1',
      createdBy: 'user',
      executedBy: 'agent',
      revisionCount: 0,
      artifacts: [],
    });
    expect(parent.id).toMatch(/^tsk_/);
    await sleep(2);
    const child = t.repos.tasks.create({ title: 'Write tests', parentTaskId: parent.id, createdBy: b.id });

    expect(t.repos.tasks.list({ parentTaskId: null }).map((x) => x.id)).toEqual([parent.id]);
    expect(t.repos.tasks.list({ parentTaskId: parent.id }).map((x) => x.id)).toEqual([child.id]);
    expect(t.repos.tasks.list({ assigneeBotId: b.id }).map((x) => x.id)).toEqual([parent.id]);

    const up = t.repos.tasks.update(child.id, {
      status: 'in_review',
      artifacts: ['/shared/out.md'],
      resultSummaryMd: 'done',
      revisionCount: 1,
    });
    expect(up).toMatchObject({ status: 'in_review', artifacts: ['/shared/out.md'], revisionCount: 1 });
    expect(t.repos.tasks.list({ status: ['in_review', 'done'] }).map((x) => x.id)).toEqual([child.id]);
    expect(() => t.repos.tasks.update(child.id, { status: 'nope' as never })).toThrow();

    t.repos.tasks.addEvent({ taskId: child.id, kind: 'status', actor: 'user', payload: { to: 'in_review' } });
    const ev = t.repos.tasks.addEvent({ taskId: child.id, kind: 'comment', actor: b.id });
    expect(ev.id).toMatch(/^tev_/);
    expect(t.repos.tasks.listEvents(child.id).map((e) => e.kind)).toEqual(['status', 'comment']);

    // Deleting the parent detaches the child rather than deleting it.
    expect(t.repos.tasks.delete(parent.id)).toBe(true);
    expect(t.repos.tasks.get(child.id)?.parentTaskId).toBeNull();
    t.repos.tasks.delete(child.id);
    expect(t.repos.tasks.listEvents(child.id)).toEqual([]);
  });

  it('unassigns tasks when the assignee bot is deleted', () => {
    const b = t.repos.bots.create({ name: 'Dev', engine: 'mock' });
    const task = t.repos.tasks.create({ title: 'x', assigneeBotId: b.id });
    t.repos.bots.delete(b.id);
    expect(t.repos.tasks.get(task.id)?.assigneeBotId).toBeNull();
  });
});
