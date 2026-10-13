import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Bot, type Goal, type Message, type Repos, type Run, type Task, slugify } from '@agenta/db';
import {
  type GoalCreateRequest,
  type GoalView,
  type LiveGoalChanged,
  type LiveTaskChanged,
  goalCreateRequestSchema,
  newId,
  nowIso,
} from '@agenta/shared';
import type { EventBus } from '../bus';
import { type PromptGoal, buildPrompt } from '../engines/prompt';
import { RunError, type RunService } from '../runs/service';
import type { TaskService } from '../tasks/service';
import type { ThreadService } from '../threads/service';

type Log = { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };

export class GoalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export type GoalServiceOptions = {
  repos: Repos;
  bus: EventBus;
  log: Log;
  runs: Pick<RunService, 'enqueue' | 'cancel'>;
  threads: Pick<ThreadService, 'send' | 'publish'>;
  tasks: Pick<TaskService, 'start'>;
  /** Host folder mounted at /shared in every computer: the goal's artifacts folder is created there. */
  sharedDir?: string;
};

/** The goal as prompts show it (engines/prompt.ts). */
export function toPromptGoal(repos: Repos, goal: Goal): PromptGoal {
  const tasks = repos.goals.listTasks(goal.id);
  return {
    ...goal,
    tasksTotal: tasks.length,
    tasksDone: tasks.filter((t) => t.status === 'done').length,
  };
}

export function publishGoalChanged(bus: EventBus, goalId: string): void {
  const event: LiveGoalChanged = { type: 'goal.changed', goalId };
  bus.publish('global', event);
}

/**
 * Goals (PLAN F20): the owner states a goal, Agent A (the lead) plans it in the goal's own thread and, once the owner
 * confirms (or right away with auto-run), creates the tasks; each assigned task starts in its task thread. The
 * lead's turns there get the planning protocol in their system prompt (RunService.buildInput).
 */
export class GoalService {
  constructor(private readonly opts: GoalServiceOptions) {
    // Any task change may move a goal along (progress, all done → report).
    opts.bus.subscribe('global', (e) => {
      const event = e as LiveTaskChanged;
      if (event.type !== 'task.changed') return;
      const goalId = opts.repos.tasks.get(event.taskId)?.goalId;
      if (goalId) this.sync(goalId);
    });
  }

  private goal(id: string): Goal {
    const goal = this.opts.repos.goals.get(id);
    if (!goal) throw new GoalError('goal_not_found', `Goal ${id} not found`, 404);
    return goal;
  }

  private view(goal: Goal): GoalView {
    const p = toPromptGoal(this.opts.repos, goal);
    return {
      ...goal,
      tasksTotal: p.tasksTotal,
      tasksDone: p.tasksDone,
      runsUsed: this.opts.repos.goals.countRuns(goal.id),
    };
  }

  private changed(goalId: string): void {
    publishGoalChanged(this.opts.bus, goalId);
  }

  list(): GoalView[] {
    return this.opts.repos.goals.list().map((g) => this.view(g));
  }

  get(id: string): GoalView {
    return this.view(this.goal(id));
  }

  /** Opens the goal's thread with the lead and posts the goal there, which starts the lead's planning turn. */
  create(body: GoalCreateRequest): GoalView {
    const { repos, log } = this.opts;
    const req = goalCreateRequestSchema.parse(body);
    const lead = repos.bots.getLead();
    if (!lead) throw new GoalError('no_lead', 'There is no lead bot (Agent A) to plan the goal', 409);
    const title = (req.title || req.goalMd.split('\n')[0]!.replace(/^#+\s*/, '')).trim().slice(0, 120);
    const slug = `${slugify(title).slice(0, 40)}-${newId('goal').slice(4, 10).toLowerCase()}`;
    const thread = repos.threads.create({ kind: 'goal', title, memberBotIds: [lead.id] });
    const goal = repos.goals.create({
      title,
      slug,
      goalMd: req.goalMd,
      constraintsMd: req.constraintsMd,
      autoRun: req.autoRun,
      maxTasks: req.maxTasks,
      maxRuns: req.maxRuns,
      leadBotId: lead.id,
      threadId: thread.id,
    });
    if (this.opts.sharedDir) {
      try {
        mkdirSync(join(this.opts.sharedDir, 'projects', slug), { recursive: true });
      } catch (err) {
        log.warn({ goalId: goal.id, err: (err as Error).message }, 'could not create the artifacts folder');
      }
    }
    const content = req.constraintsMd
      ? `${req.goalMd}\n\n**Constraints:**\n${req.constraintsMd}`
      : req.goalMd;
    this.opts.threads.send(thread.id, { content });
    log.info({ goalId: goal.id, threadId: thread.id, autoRun: goal.autoRun }, 'goal created');
    this.changed(goal.id);
    return this.get(goal.id);
  }

  /** The owner confirms the lead's plan: the lead's next turn creates the tasks. */
  confirm(id: string): GoalView {
    const goal = this.goal(id);
    if (goal.confirmedAt) throw new GoalError('already_confirmed', 'The plan is already confirmed', 409);
    if (goal.pausedAt) throw new GoalError('goal_paused', 'Resume the goal first', 409);
    if (!goal.threadId) throw new GoalError('no_thread', 'The goal has no thread', 409);
    this.opts.repos.goals.update(id, { confirmedAt: nowIso() });
    this.opts.threads.send(goal.threadId, {
      content: 'I confirm the plan. Please create the tasks and start.',
    });
    this.changed(id);
    return this.get(id);
  }

  /**
   * Moves the goal along after a task change: planning → in progress once it has tasks, and once every task is done
   * the lead writes the goal report.
   */
  sync(goalId: string): void {
    const { repos } = this.opts;
    let goal = repos.goals.get(goalId);
    if (!goal) return;
    const tasks = repos.goals.listTasks(goalId);
    if (goal.status === 'planning' && tasks.length > 0) {
      goal = repos.goals.update(goalId, { status: 'in_progress' })!;
    }
    if (
      goal.status === 'in_progress' &&
      !goal.pausedAt &&
      tasks.length > 0 &&
      tasks.every((t) => t.status === 'done')
    ) {
      this.startReport(goal, tasks);
    }
    this.changed(goalId);
  }

  /** A system message in the goal's thread (optionally tied to the run it announces). */
  private say(goal: Goal, text: string, runId?: string): Message | undefined {
    if (!goal.threadId) return undefined;
    const { messages } = this.opts.repos;
    const msg = messages.create({ threadId: goal.threadId, authorType: 'system', contentMd: text });
    const stored = runId ? (messages.setRunId(msg.id, runId) ?? msg) : msg;
    this.opts.threads.publish(stored);
    return stored;
  }

  /** Something blocked the goal (budget, pause, a missing lead): tell the owner in the thread and the inbox. */
  private blocked(goal: Goal, what: string, err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    this.opts.log.warn({ goalId: goal.id, err: reason }, `goal: ${what}`);
    this.say(goal, `Could not ${what}: ${reason}.`);
    this.opts.repos.notifications.create({
      kind: 'goal.blocked',
      title: `Goal "${goal.title}" needs you`,
      body: `Could not ${what}: ${reason}.`,
      link: goal.threadId ? `/threads/${goal.threadId}` : '/',
    });
  }

  private startReport(goal: Goal, tasks: Task[]): Run | undefined {
    const { repos } = this.opts;
    const lead = goal.leadBotId ? repos.bots.get(goal.leadBotId) : undefined;
    const thread = goal.threadId ? repos.threads.get(goal.threadId) : undefined;
    if (!lead || lead.archivedAt || !thread) {
      this.blocked(goal, 'start the goal report', new Error('the lead or the goal thread is gone'));
      return undefined;
    }
    const names = new Map(repos.bots.list({ includeArchived: true }).map((b) => [b.id, b.name]));
    const prompt = buildPrompt({
      bot: lead,
      thread,
      newMessages: [],
      goal: toPromptGoal(repos, goal),
      report: tasks.map((t) => ({ ...t, assigneeName: names.get(t.assigneeBotId ?? '') ?? 'unassigned' })),
    });
    let run: Run;
    try {
      run = this.opts.runs.enqueue({ botId: lead.id, threadId: thread.id, trigger: 'review', prompt });
    } catch (err) {
      if (err instanceof RunError) {
        this.blocked(goal, 'start the goal report', err);
        return undefined;
      }
      throw err;
    }
    repos.goals.update(goal.id, { status: 'reporting', reportRunId: run.id });
    this.say(goal, `All ${tasks.length} tasks are done. ${lead.name} is writing the goal report.`, run.id);
    this.opts.log.info({ goalId: goal.id, runId: run.id }, 'goal report started');
    return run;
  }

  /** A goal task was handed in: the lead reviews it in the goal thread (not its own work: the owner reviews that). */
  onSubmitted(task: Task): Run | undefined {
    const { repos } = this.opts;
    const goal = task.goalId ? repos.goals.get(task.goalId) : undefined;
    if (!goal || goal.pausedAt) return undefined;
    const lead = goal.leadBotId ? repos.bots.get(goal.leadBotId) : undefined;
    const thread = goal.threadId ? repos.threads.get(goal.threadId) : undefined;
    if (!lead || lead.archivedAt || !thread) {
      this.blocked(goal, `review "${task.title}"`, new Error('the lead or the goal thread is gone'));
      return undefined;
    }
    if (task.assigneeBotId === lead.id) return undefined;
    const reviewing = repos.runs.list({ taskId: task.id, botId: lead.id, status: 'queued', limit: 1 })[0];
    if (reviewing) return reviewing;
    const assignee = task.assigneeBotId ? repos.bots.get(task.assigneeBotId) : undefined;
    const prompt = buildPrompt({
      bot: lead,
      thread,
      newMessages: [],
      goal: toPromptGoal(repos, goal),
      review: { ...task, assigneeName: assignee?.name ?? 'a former teammate' },
    });
    let run: Run;
    try {
      run = this.opts.runs.enqueue({
        botId: lead.id,
        threadId: thread.id,
        taskId: task.id,
        trigger: 'review',
        prompt,
      });
    } catch (err) {
      if (err instanceof RunError) {
        this.blocked(goal, `review "${task.title}"`, err);
        return undefined;
      }
      throw err;
    }
    this.say(goal, `${assignee?.name ?? 'The assignee'} handed in "${task.title}" for review.`, run.id);
    this.opts.log.info({ goalId: goal.id, taskId: task.id, runId: run.id }, 'goal task review queued');
    return run;
  }

  /** The lead wanted yet another round of changes: the owner decides (the task stays in review). */
  escalate(task: Task, lead: Bot, feedback: string): void {
    const goal = task.goalId ? this.opts.repos.goals.get(task.goalId) : undefined;
    const text = `${lead.name} still wants changes on "${task.title}" after ${task.revisionCount} rounds, so it is your call: approve it or request changes on the task board.\n\n> ${feedback.replace(/\n/g, '\n> ')}`;
    if (goal) this.say(goal, text);
    this.opts.repos.notifications.create({
      kind: 'task.escalated',
      title: `Your review is needed: ${task.title}`,
      body: text.slice(0, 2000),
      link: '/tasks',
    });
  }

  /** Pause: the goal's queued turns are cancelled and no new ones start (running turns finish). */
  async pause(id: string): Promise<GoalView> {
    const { repos, log } = this.opts;
    const goal = this.goal(id);
    if (goal.pausedAt) return this.get(id);
    repos.goals.update(id, { pausedAt: nowIso() });
    let cancelled = 0;
    for (const run of repos.runs.list({ goalId: id, status: 'queued', limit: 500 })) {
      try {
        await this.opts.runs.cancel(run.id);
        cancelled++;
      } catch {
        // It started or finished meanwhile.
      }
    }
    this.say(
      goal,
      `Goal paused by the owner${cancelled ? `: ${cancelled} queued turn${cancelled === 1 ? '' : 's'} cancelled` : ''}. Nothing new starts until you resume it.`,
    );
    log.info({ goalId: id, cancelled }, 'goal paused');
    this.changed(id);
    return this.get(id);
  }

  /**
   * Resume: restarts what the pause stopped: assigned tasks with no turn queued or running, handed-in tasks waiting
   * for a review (unless escalated to the owner), and the goal report.
   */
  resume(id: string): GoalView {
    const { repos, log } = this.opts;
    let goal = this.goal(id);
    if (!goal.pausedAt) return this.get(id);
    goal = repos.goals.update(id, { pausedAt: null })!;
    this.say(goal, 'Goal resumed by the owner.');
    const active = (taskId: string, botId: string | null) =>
      !!botId && repos.runs.list({ taskId, botId, status: ['queued', 'running'], limit: 1 }).length > 0;
    const tasks = repos.goals.listTasks(id);
    let restarted = 0;
    try {
      for (const t of tasks) {
        if (!t.assigneeBotId || t.executedBy === 'human') continue;
        if (
          ['todo', 'in_progress', 'changes_requested'].includes(t.status) &&
          !active(t.id, t.assigneeBotId)
        ) {
          this.opts.tasks.start(t.id, 'The owner resumed the goal; please continue.');
          restarted++;
        } else if (t.status === 'in_review' && !active(t.id, goal.leadBotId)) {
          const last = repos.tasks.listEvents(t.id).at(-1);
          if (last?.kind !== 'escalated' && this.onSubmitted(t)) restarted++;
        }
      }
    } catch (err) {
      this.blocked(goal, 'restart the goal’s work', err);
    }
    // A report that never finished is written again.
    if (goal.status === 'reporting' && goal.reportRunId) {
      const report = repos.runs.get(goal.reportRunId);
      if (report?.status !== 'queued' && report?.status !== 'running' && report?.status !== 'succeeded') {
        repos.goals.update(id, { status: 'in_progress', reportRunId: null });
      }
    }
    log.info({ goalId: id, restarted }, 'goal resumed');
    this.sync(id);
    return this.get(id);
  }

  /** A finished turn's reply: the goal report completes the goal. */
  onReply(run: Run): void {
    if (!run.goalId) return;
    const goal = this.opts.repos.goals.get(run.goalId);
    if (!goal || goal.reportRunId !== run.id || goal.status === 'done') return;
    this.opts.repos.goals.update(goal.id, { status: 'done', finishedAt: nowIso() });
    this.opts.repos.notifications.create({
      kind: 'goal.done',
      title: `Goal done: ${goal.title}`,
      body: 'Agent A posted the goal report.',
      link: goal.threadId ? `/threads/${goal.threadId}` : '/',
    });
    this.opts.log.info({ goalId: goal.id }, 'goal done');
    this.changed(goal.id);
  }
}
