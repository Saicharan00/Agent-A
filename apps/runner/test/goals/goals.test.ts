import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GoalView, MessageView } from '@agenta/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotService } from '../../src/bots/service';
import { loadConfig } from '../../src/config';
import { MockEngine } from '../../src/engines/mock';
import { GoalService } from '../../src/goals/service';
import { PlatformTools } from '../../src/mcp/tools';
import { buildServer } from '../../src/server';
import { TaskService } from '../../src/tasks/service';
import { ThreadService } from '../../src/threads/service';
import { type Harness, makeHarness, silent } from '../runs/helpers';

// F20: goal → plan → (confirm) → tasks → specialists hand in → lead reviews (one rework) → report, on the mock engine.
describe('goal delegation loop', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const };
  let h: Harness;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let platform: PlatformTools;
  let goals: GoalService;
  let lead: string;
  let sharedDir: string;

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
    sharedDir = join(h.dir, 'shared');
    const bots = new BotService({ repos: h.repos, bus: h.bus, log: silent, botsDir, runs: h.service });
    const threads = new ThreadService({
      repos: h.repos,
      bus: h.bus,
      log: silent,
      botsDir,
      bots,
      runs: h.service,
    });
    const tasks = new TaskService({ repos: h.repos, bus: h.bus, log: silent, runs: h.service, threads });
    goals = new GoalService({
      repos: h.repos,
      bus: h.bus,
      log: silent,
      runs: h.service,
      threads,
      tasks,
      sharedDir,
    });
    h.service.onReply = (run, reply) => {
      threads.routeBotMessage(reply, run);
      goals.onReply(run);
    };
    platform = new PlatformTools({ repos: h.repos, threads, bus: h.bus, tasks, goals, log: silent });
    app = await buildServer(config, { repos: h.repos, runs: h.service, bots, threads, tasks, goals });
    lead = h.repos.bots.create({ name: 'Agent A', slug: 'agent-a', engine: 'mock', isLead: true }).id;
    bots.create({ name: 'Alice', engine: 'mock', role: 'Backend' });
    bots.create({ name: 'Bob', engine: 'mock', role: 'Docs' });
  });
  afterEach(async () => {
    await app.close();
    h.close();
  });

  const req = async <T>(method: 'GET' | 'POST', url: string, payload?: object) => {
    const res = await app.inject({ method, url, payload });
    return { status: res.statusCode, body: res.json<T>() };
  };
  const goal = async (id: string) => (await req<GoalView>('GET', `/api/goals/${id}`)).body;
  const thread = async (id: string) =>
    (await req<{ messages: MessageView[] }>('GET', `/api/threads/${id}/messages?limit=200`)).body.messages;

  it('plans, waits for confirmation, then runs the whole loop to the goal report', async () => {
    const created = await req<GoalView>('POST', '/api/goals', {
      goalMd: 'Launch page for the side project [mock:plan]',
      constraintsMd: 'No real customer data',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      title: 'Launch page for the side project [mock:plan]',
      status: 'planning',
      leadBotId: lead,
      autoRun: false,
      maxTasks: 12,
      maxRuns: 40,
    });
    expect(existsSync(join(sharedDir, 'projects', created.body.slug))).toBe(true);
    const id = created.body.id;
    const threadId = created.body.threadId!;
    expect(h.repos.threads.get(threadId)?.kind).toBe('goal');

    const [planning] = h.repos.runs.list({ threadId });
    expect(planning!.goalId).toBe(id);
    expect(planning!.prompt).toContain(`## Goal ${id}:`);
    expect(planning!.prompt).toContain('No real customer data');
    expect(planning!.prompt).toContain('waiting for the owner');
    await h.service.idle();

    // The lead proposed a plan and created nothing.
    expect(h.repos.goals.listTasks(id)).toHaveLength(0);
    expect((await thread(threadId)).at(-1)?.contentMd).toContain('Confirm the plan to start.');
    expect((await goal(id)).status).toBe('planning');

    expect((await req<GoalView>('POST', `/api/goals/${id}/confirm`)).status).toBe(200);
    expect((await req('POST', `/api/goals/${id}/confirm`)).status).toBe(409);
    await h.service.idle();

    const tasks = h.repos.goals.listTasks(id);
    expect(tasks.map((t) => t.title)).toEqual([
      'Research the options',
      'Build the prototype (rework once)',
      'Write the summary',
    ]);
    expect(tasks.every((t) => t.status === 'done')).toBe(true);
    expect(tasks.map((t) => t.revisionCount)).toEqual([0, 1, 0]);
    // Specialists got the brief with the goal context and the artifacts folder.
    const brief = h.repos.runs.list({ taskId: tasks[0]!.id, botId: tasks[0]!.assigneeBotId! })[0]!;
    expect(brief.prompt).toContain('### Goal context: Launch page');
    expect(brief.prompt).toContain(`/shared/projects/${created.body.slug}/`);
    expect(brief.goalId).toBe(id);
    // The rework round: request changes, a second hand-in, then approval.
    expect(
      h.repos.tasks
        .listEvents(tasks[1]!.id)
        .filter((e) => e.kind === 'reviewed')
        .map((e) => e.payload.verdict),
    ).toEqual(['request_changes', 'approve']);

    const done = await goal(id);
    expect(done).toMatchObject({ status: 'done', tasksTotal: 3, tasksDone: 3 });
    expect(done.finishedAt).toBeTruthy();
    // plan + confirm turn + 4 task turns + 4 reviews + report
    expect(done.runsUsed).toBe(11);
    const msgs = await thread(threadId);
    expect(msgs.some((m) => m.contentMd.includes('handed in "Write the summary" for review'))).toBe(true);
    expect(msgs.at(-1)?.contentMd).toContain('## Goal report');
    expect(h.repos.decisions.list().map((d) => d.title)).toContain('Ship the prototype first');
    expect(h.repos.lessons.list().length).toBe(1);
    expect(h.repos.notifications.list().map((n) => n.kind)).toContain('goal.done');
  });

  it('auto-run skips the confirmation; the task limit is enforced', async () => {
    const created = await req<GoalView>('POST', '/api/goals', {
      title: 'Small goal',
      goalMd: 'Do it [mock:plan]',
      autoRun: true,
      maxTasks: 2,
    });
    await h.service.idle();
    const id = created.body.id;
    expect(h.repos.goals.listTasks(id)).toHaveLength(2);
    const planRun = h.repos.runs.list({ threadId: created.body.threadId!, botId: lead }).at(-1)!;
    const results = h.repos.runs.listEvents(planRun.id).filter((e) => e.type === 'tool.result');
    expect(JSON.stringify(results.at(-1)!.payload)).toContain('maximum of 2 tasks');
    // The two tasks still complete and the report follows.
    expect((await goal(id)).status).toBe('done');
  });

  it('the run budget stops new turns and tells the owner', async () => {
    const created = await req<GoalView>('POST', '/api/goals', {
      goalMd: 'Budget goal [mock:plan]',
      autoRun: true,
      maxRuns: 3,
    });
    await h.service.idle();
    const g = await goal(created.body.id);
    expect(g.runsUsed).toBe(3);
    const msgs = await thread(created.body.threadId!);
    expect(
      msgs.some((m) => m.authorType === 'system' && m.contentMd.includes('used all 3 of its runs')),
    ).toBe(true);
    expect(h.repos.notifications.list().map((n) => n.kind)).toContain('goal.blocked');
    // The owner can't start more turns in the goal thread either.
    const send = await req('POST', `/api/threads/${created.body.threadId}/messages`, { content: 'more?' });
    expect(send.status).toBe(409);
  });

  it('pause cancels queued turns and starts nothing; resume picks the work up again', async () => {
    const created = await req<GoalView>('POST', '/api/goals', {
      goalMd: 'Pause goal [mock:plan]',
      autoRun: true,
    });
    const id = created.body.id;
    // The planning turn is queued: pausing cancels it.
    const paused = await req<GoalView>('POST', `/api/goals/${id}/pause`);
    expect(paused.body.pausedAt).toBeTruthy();
    await h.service.idle();
    expect(h.repos.runs.list({ goalId: id }).map((r) => r.status)).toEqual(['cancelled']);
    const send = await req<{ error: { code: string } }>(
      'POST',
      `/api/threads/${created.body.threadId}/messages`,
      { content: 'go' },
    );
    expect(send.body.error.code).toBe('goal_paused');

    await req('POST', `/api/goals/${id}/resume`);
    // Nothing was assigned yet, so the owner restarts planning by writing in the thread.
    expect(
      (await req('POST', `/api/threads/${created.body.threadId}/messages`, { content: 'go' })).status,
    ).toBe(201);
    await h.service.idle();
    expect((await goal(id)).status).toBe('done');
  });

  it('resume restarts assigned tasks whose turns the pause cancelled', async () => {
    const created = await req<GoalView>('POST', '/api/goals', {
      goalMd: 'Resume goal [mock:plan]',
      autoRun: true,
    });
    const id = created.body.id;
    // Let the planning turn create the tasks, then pause while their turns are queued.
    const planRun = h.repos.runs.list({ goalId: id })[0]!;
    await new Promise<void>((resolve) => {
      const off = h.bus.subscribe(`run:${planRun.id}`, (e) => {
        if ((e as { type: string; status?: string }).status === 'succeeded') {
          off();
          resolve();
        }
      });
      h.service.tick();
    });
    await req('POST', `/api/goals/${id}/pause`);
    await h.service.idle();
    expect(h.repos.goals.listTasks(id).some((t) => t.status !== 'done')).toBe(true);
    await req('POST', `/api/goals/${id}/resume`);
    await h.service.idle();
    expect((await goal(id)).status).toBe('done');
  });

  it('delete removes the goal and its tasks, stops their turns and keeps the history', async () => {
    const created = await req<GoalView>('POST', '/api/goals', {
      goalMd: 'Delete goal [mock:plan]',
      autoRun: true,
    });
    const id = created.body.id;
    const threadId = created.body.threadId!;
    // Let the planning turn create the tasks; their turns are then queued.
    const planRun = h.repos.runs.list({ goalId: id })[0]!;
    await new Promise<void>((resolve) => {
      const off = h.bus.subscribe(`run:${planRun.id}`, (e) => {
        if ((e as { type: string; status?: string }).status === 'succeeded') {
          off();
          resolve();
        }
      });
      h.service.tick();
    });
    const taskIds = h.repos.goals.listTasks(id).map((t) => t.id);
    expect(taskIds.length).toBeGreaterThan(0);
    const runIds = h.repos.runs.list({ goalId: id }).map((r) => r.id);
    const queued = h.repos.runs.list({ goalId: id, status: 'queued' }).map((r) => r.id);
    expect(queued.length).toBeGreaterThan(0);

    const res = await app.inject({ method: 'DELETE', url: `/api/goals/${id}` });
    expect(res.statusCode).toBe(204);
    await h.service.idle();

    expect((await req('GET', `/api/goals/${id}`)).status).toBe(404);
    expect(taskIds.map((t) => h.repos.tasks.get(t))).toEqual(taskIds.map(() => undefined));
    // Runs stay as history, unlinked, and none is left queued or running.
    const kept = runIds.map((r) => h.repos.runs.get(r)!);
    expect(kept.every((r) => r && r.goalId === null)).toBe(true);
    expect(kept.some((r) => r.status === 'queued' || r.status === 'running')).toBe(false);
    expect(queued.map((r) => h.repos.runs.get(r)!.status)).toEqual(queued.map(() => 'cancelled'));
    expect(h.repos.threads.get(threadId)).toBeTruthy();

    expect((await app.inject({ method: 'DELETE', url: '/api/goals/goal_nope' })).statusCode).toBe(404);
  });

  it('needs a lead bot', async () => {
    h.repos.bots.update(lead, { isLead: false });
    const res = await req<{ error: { code: string } }>('POST', '/api/goals', { goalMd: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('no_lead');
  });

  it('the lead cannot create goal tasks before the owner confirms the plan', async () => {
    const created = await req<GoalView>('POST', '/api/goals', { goalMd: 'Wait for me' });
    await h.service.idle();
    const run = h.repos.runs.create({
      botId: lead,
      threadId: created.body.threadId,
      trigger: 'user',
      engine: 'mock',
      prompt: 'x',
      goalId: created.body.id,
    });
    h.repos.runs.markRunning(run.id);
    await expect(
      platform.call(h.repos.bots.get(lead)!, 'create_task', { title: 'Too early', assignee: 'self' }),
    ).rejects.toThrow(/not confirmed the plan/);
  });

  it('after two rounds of changes the lead escalates to the owner', async () => {
    const alice = h.repos.bots.getBySlug('alice')!;
    const task = h.repos.tasks.create({
      title: 'Hard one',
      assigneeBotId: alice.id,
      status: 'in_review',
      createdBy: lead,
    });
    h.repos.tasks.update(task.id, { revisionCount: 2 });
    const res = (await platform.call(h.repos.bots.get(lead)!, 'review_task', {
      id: task.id,
      verdict: 'request_changes',
      feedback: 'Still not right',
    })) as { escalated: boolean; status: string };
    expect(res).toMatchObject({ escalated: true, status: 'in_review' });
    expect(h.repos.tasks.listEvents(task.id).at(-1)?.kind).toBe('escalated');
    expect(h.repos.notifications.list().map((n) => n.kind)).toContain('task.escalated');
    expect(h.repos.runs.list({ taskId: task.id })).toHaveLength(0);
  });
});
