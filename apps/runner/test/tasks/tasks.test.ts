import { join } from 'node:path';
import type { MessageView, TaskDetail, TaskView } from '@agenta/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotService } from '../../src/bots/service';
import { loadConfig } from '../../src/config';
import { MockEngine } from '../../src/engines/mock';
import { PlatformTools } from '../../src/mcp/tools';
import { buildServer } from '../../src/server';
import { TaskService } from '../../src/tasks/service';
import { ThreadService } from '../../src/threads/service';
import { type Harness, makeHarness, silent } from '../runs/helpers';

// F19: the task board API. Assigning starts a task run in its task thread; the mock hands in a result.
describe('task board API', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const };
  let h: Harness;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let alice: string;

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
    const threads = new ThreadService({
      repos: h.repos,
      bus: h.bus,
      log: silent,
      botsDir,
      bots,
      runs: h.service,
    });
    const platform = new PlatformTools({ repos: h.repos, threads, bus: h.bus, log: silent });
    const tasks = new TaskService({ repos: h.repos, bus: h.bus, log: silent, runs: h.service, threads });
    app = await buildServer(config, { repos: h.repos, runs: h.service, bots, threads, tasks });
    alice = bots.create({ name: 'Alice', engine: 'mock', role: 'Frontend' }).id;
  });
  afterEach(async () => {
    await app.close();
    h.close();
  });

  const req = async <T>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) => {
    const res = await app.inject({ method, url, payload });
    return { status: res.statusCode, body: res.json<T>() };
  };
  const taskEvents = () => h.published.filter((p) => p.event.type === 'task.changed');

  it('creates an unassigned task without starting it', async () => {
    const res = await req<TaskDetail>('POST', '/api/tasks', { title: 'Write docs', priority: 'p1' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: 'Write docs',
      status: 'todo',
      priority: 'p1',
      createdBy: 'user',
    });
    expect(res.body.events.map((e) => e.kind)).toEqual(['created']);
    expect(h.repos.runs.list({ taskId: res.body.id })).toHaveLength(0);
    expect(taskEvents()).toEqual([
      { channel: 'global', event: { type: 'task.changed', taskId: res.body.id } },
    ]);
    expect((await req<TaskView[]>('GET', '/api/tasks')).body.map((t) => t.id)).toEqual([res.body.id]);
  });

  it('assigning a bot starts it; the mock hands in a result, so it ends in review', async () => {
    const created = await req<TaskDetail>('POST', '/api/tasks', {
      title: 'Build the page',
      descriptionMd: 'Make it nice [mock:task]',
      acceptanceMd: '- renders',
    });
    const res = await req<TaskDetail>('PATCH', `/api/tasks/${created.body.id}`, { assigneeBotId: alice });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('in_progress');
    expect(res.body.taskThreadId).toBeTruthy();
    const [run] = h.repos.runs.list({ taskId: created.body.id });
    expect(run).toMatchObject({ botId: alice, trigger: 'task', threadId: res.body.taskThreadId });
    expect(run!.prompt).toContain(`## Task ${created.body.id}: Build the page`);
    expect(run!.prompt).toContain('submit_task_result');
    const thread = h.repos.threads.get(res.body.taskThreadId!)!;
    expect(thread.kind).toBe('task');
    expect(h.repos.threads.isMember(thread.id, alice)).toBe(true);

    await h.service.idle();
    const done = (await req<TaskDetail>('GET', `/api/tasks/${created.body.id}`)).body;
    expect(done).toMatchObject({ status: 'in_review', artifacts: ['/shared/mock-result.md'] });
    expect(done.resultSummaryMd).toBe('Done by the mock engine.');
    expect(done.events.map((e) => e.kind)).toEqual([
      'created',
      'assigned',
      'status',
      'started',
      'note',
      'submitted',
    ]);
    // Tool calls are announced live too.
    expect(taskEvents().length).toBeGreaterThanOrEqual(4);
    const msgs = await req<{ messages: MessageView[] }>('GET', `/api/threads/${thread.id}/messages`);
    expect(msgs.body.messages.map((m) => m.authorType)).toEqual(['user', 'bot']);
  });

  it('creating with an assignee starts at once; human-executed tasks do not start', async () => {
    const auto = await req<TaskDetail>('POST', '/api/tasks', { title: 'A', assigneeBotId: alice });
    expect(auto.body.status).toBe('in_progress');
    const human = await req<TaskDetail>('POST', '/api/tasks', {
      title: 'B',
      assigneeBotId: alice,
      executedBy: 'human',
    });
    expect(human.body.status).toBe('todo');
    expect(h.repos.runs.list({ taskId: human.body.id })).toHaveLength(0);
    await h.service.idle();
  });

  it('owner status changes are recorded; start refuses while running and without assignee', async () => {
    const t = (await req<TaskDetail>('POST', '/api/tasks', { title: 'Drag me' })).body;
    expect((await req('POST', `/api/tasks/${t.id}/start`)).body).toMatchObject({
      error: { code: 'no_assignee' },
    });
    const moved = await req<TaskDetail>('PATCH', `/api/tasks/${t.id}`, { status: 'blocked' });
    expect(moved.body.status).toBe('blocked');
    expect(moved.body.events.at(-1)).toMatchObject({
      kind: 'status',
      actor: 'user',
      payload: { from: 'todo', to: 'blocked' },
    });
    await req('PATCH', `/api/tasks/${t.id}`, { assigneeBotId: alice });
    const again = await req('POST', `/api/tasks/${t.id}/start`);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { code: 'task_running' } });
    await h.service.idle();
  });

  it('approve and request changes act on tasks in review', async () => {
    const t = (
      await req<TaskDetail>('POST', '/api/tasks', {
        title: 'Review me',
        descriptionMd: '[mock:task]',
        assigneeBotId: alice,
      })
    ).body;
    expect((await req('POST', `/api/tasks/${t.id}/approve`)).status).toBe(409);
    await h.service.idle();
    const changes = await req<TaskDetail>('POST', `/api/tasks/${t.id}/request-changes`, {
      feedback: 'Add tests',
    });
    expect(changes.body).toMatchObject({ status: 'changes_requested', revisionCount: 1 });
    const runs = h.repos.runs.list({ taskId: t.id });
    expect(runs).toHaveLength(2);
    expect(runs[0]!.prompt).toContain('Add tests');
    await h.service.idle();
    expect((await req<TaskDetail>('POST', `/api/tasks/${t.id}/approve`)).body.status).toBe('done');
  });

  it('validates input and parents', async () => {
    expect((await req('POST', '/api/tasks', { title: '' })).status).toBe(400);
    expect((await req('POST', '/api/tasks', { title: 'x', assigneeBotId: 'bot_nope' })).status).toBe(404);
    const parent = (await req<TaskDetail>('POST', '/api/tasks', { title: 'Parent' })).body;
    const child = (await req<TaskDetail>('POST', '/api/tasks', { title: 'Child', parentTaskId: parent.id }))
      .body;
    expect((await req<TaskDetail>('GET', `/api/tasks/${parent.id}`)).body.subtasks.map((s) => s.id)).toEqual([
      child.id,
    ]);
    const cycle = await req('PATCH', `/api/tasks/${parent.id}`, { parentTaskId: child.id });
    expect(cycle.body).toMatchObject({ error: { code: 'parent_cycle' } });
    expect((await req('GET', '/api/tasks/tsk_missing')).status).toBe(404);
  });
});
