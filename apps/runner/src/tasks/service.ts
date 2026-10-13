import type { Bot, Repos, Task } from '@agenta/db';
import {
  type LiveTaskChanged,
  type TaskCreateRequest,
  type TaskDetail,
  type TaskPatchRequest,
  type TaskRequestChanges,
  type TaskView,
  taskCreateRequestSchema,
  taskPatchRequestSchema,
  taskRequestChangesSchema,
  taskViewSchema,
} from '@agenta/shared';
import type { EventBus } from '../bus';
import { buildPrompt, toPromptMessages } from '../engines/prompt';
import type { RunService } from '../runs/service';
import type { ThreadService } from '../threads/service';

type Log = { info(obj: object, msg?: string): void };

export class TaskError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export type TaskServiceOptions = {
  repos: Repos;
  bus: EventBus;
  log: Log;
  runs: Pick<RunService, 'enqueue'>;
  threads: Pick<ThreadService, 'publish'>;
};

/** The owner is the actor of every change made through the API. */
const OWNER = 'user';

export function toTaskView(t: Task): TaskView {
  return taskViewSchema.parse(t);
}

/** Tells every client the task changed (board and drawer refetch). Also used by the Platform MCP tools. */
export function publishTaskChanged(bus: EventBus, taskId: string): void {
  const event: LiveTaskChanged = { type: 'task.changed', taskId };
  bus.publish('global', event);
}

/**
 * The task board (PLAN F19): the owner's view of tasks and the actions on them. Starting a task opens (or reuses)
 * its task thread with the assignee and queues a `task` run whose prompt carries the task brief.
 */
export class TaskService {
  constructor(private readonly opts: TaskServiceOptions) {}

  private task(id: string): Task {
    const task = this.opts.repos.tasks.get(id);
    if (!task) throw new TaskError('task_not_found', `Task ${id} not found`, 404);
    return task;
  }

  private assignee(botId: string): Bot {
    const bot = this.opts.repos.bots.get(botId);
    if (!bot) throw new TaskError('bot_not_found', `Bot ${botId} not found`, 404);
    if (bot.archivedAt) throw new TaskError('bot_archived', `${bot.name} is archived`, 409);
    return bot;
  }

  /** A parent must exist and must not be the task itself or one of its descendants. */
  private checkParent(parentId: string, taskId?: string): void {
    for (let id: string | null = parentId; id; id = this.opts.repos.tasks.get(id)?.parentTaskId ?? null) {
      if (id === taskId) throw new TaskError('parent_cycle', 'A task cannot be its own sub-task', 400);
      if (!this.opts.repos.tasks.get(id)) throw new TaskError('task_not_found', `Task ${id} not found`, 404);
    }
  }

  private event(taskId: string, kind: string, payload: Record<string, unknown> = {}): void {
    this.opts.repos.tasks.addEvent({ taskId, kind, actor: OWNER, payload });
  }

  private changed(taskId: string): void {
    publishTaskChanged(this.opts.bus, taskId);
  }

  /** Every task, most recently updated first (the board filters on the client). */
  list(): TaskView[] {
    return this.opts.repos.tasks.list().map(toTaskView);
  }

  get(id: string): TaskDetail {
    const { repos } = this.opts;
    const task = this.task(id);
    return {
      ...toTaskView(task),
      subtasks: repos.tasks.list({ parentTaskId: id }).map(toTaskView),
      events: repos.tasks.listEvents(id),
    };
  }

  create(body: TaskCreateRequest): TaskDetail {
    const req = taskCreateRequestSchema.parse(body);
    if (req.assigneeBotId) this.assignee(req.assigneeBotId);
    if (req.parentTaskId) this.checkParent(req.parentTaskId);
    const task = this.opts.repos.tasks.create({ ...req, createdBy: OWNER });
    this.event(task.id, 'created', { assignee: task.assigneeBotId });
    this.opts.log.info({ taskId: task.id }, 'task created');
    if (this.startsOnAssign(task)) this.start(task.id);
    else this.changed(task.id);
    return this.get(task.id);
  }

  update(id: string, body: TaskPatchRequest): TaskDetail {
    const { repos } = this.opts;
    const task = this.task(id);
    const patch = taskPatchRequestSchema.parse(body);
    if (patch.assigneeBotId) this.assignee(patch.assigneeBotId);
    if (patch.parentTaskId) this.checkParent(patch.parentTaskId, id);
    const updated = repos.tasks.update(id, patch)!;
    if (patch.status && patch.status !== task.status) {
      this.event(id, 'status', { from: task.status, to: patch.status });
    }
    if (patch.assigneeBotId !== undefined && patch.assigneeBotId !== task.assigneeBotId) {
      this.event(id, 'assigned', { from: task.assigneeBotId, to: patch.assigneeBotId });
      if (this.startsOnAssign(updated)) return this.start(id);
    }
    if (patch.executedBy && patch.executedBy !== task.executedBy) {
      this.event(id, 'executor', { from: task.executedBy, to: patch.executedBy });
    }
    this.changed(id);
    return this.get(id);
  }

  /** Assigning a bot starts the work unless the owner does it themselves or it is already finished. */
  private startsOnAssign(task: Task): boolean {
    return !!task.assigneeBotId && task.executedBy !== 'human' && task.status !== 'done';
  }

  /**
   * Queues the assignee's turn in the task thread (created on first start) with the task brief, and moves the task
   * to in progress. `message` is what the owner says (default: start the task).
   */
  start(id: string, message = 'Please start on this task.'): TaskDetail {
    const { repos, log } = this.opts;
    const task = this.task(id);
    if (!task.assigneeBotId) throw new TaskError('no_assignee', 'Assign the task to a bot first', 409);
    if (task.status === 'done') throw new TaskError('task_done', 'This task is done', 409);
    const bot = this.assignee(task.assigneeBotId);
    const active = repos.runs.list({ taskId: id, status: ['queued', 'running'], limit: 1 })[0];
    if (active) throw new TaskError('task_running', 'A bot is already working on this task', 409);

    let thread = task.taskThreadId ? repos.threads.get(task.taskThreadId) : undefined;
    if (!thread || thread.archivedAt) {
      thread = repos.threads.create({ kind: 'task', title: task.title.slice(0, 200), memberBotIds: [] });
      repos.tasks.update(id, { taskThreadId: thread.id });
    }
    repos.threads.addMember(thread.id, bot.id);
    const msg = repos.messages.create({ threadId: thread.id, authorType: 'user', contentMd: message });
    const status = task.status === 'todo' || task.status === 'blocked' ? 'in_progress' : task.status;
    const current = repos.tasks.update(id, { status })!;
    const prompt = buildPrompt({
      bot,
      thread,
      newMessages: toPromptMessages([msg], new Map()),
      task: current,
    });
    const run = this.opts.runs.enqueue({
      botId: bot.id,
      threadId: thread.id,
      taskId: id,
      trigger: 'task',
      prompt,
    });
    this.opts.threads.publish(repos.messages.setRunId(msg.id, run.id) ?? msg);
    if (status !== task.status) this.event(id, 'status', { from: task.status, to: status });
    this.event(id, 'started', { assignee: bot.id, runId: run.id, threadId: thread.id });
    log.info({ taskId: id, runId: run.id, botId: bot.id }, 'task started');
    this.changed(id);
    return this.get(id);
  }

  /** The owner approves handed-in work (in review → done). */
  approve(id: string): TaskDetail {
    const task = this.task(id);
    if (task.status !== 'in_review') {
      throw new TaskError('not_in_review', `Task ${id} is ${task.status}, not in_review`, 409);
    }
    this.opts.repos.tasks.update(id, { status: 'done' });
    this.event(id, 'reviewed', { verdict: 'approve' });
    this.changed(id);
    return this.get(id);
  }

  /** The owner sends handed-in work back with feedback; the assignee's next turn starts with it. */
  requestChanges(id: string, body: TaskRequestChanges): TaskDetail {
    const { feedback } = taskRequestChangesSchema.parse(body);
    const task = this.task(id);
    if (task.status !== 'in_review') {
      throw new TaskError('not_in_review', `Task ${id} is ${task.status}, not in_review`, 409);
    }
    this.opts.repos.tasks.update(id, {
      status: 'changes_requested',
      revisionCount: task.revisionCount + 1,
    });
    this.event(id, 'reviewed', { verdict: 'request_changes', feedback });
    if (task.assigneeBotId && task.executedBy !== 'human') {
      return this.start(id, `Changes requested:\n\n${feedback}`);
    }
    this.changed(id);
    return this.get(id);
  }
}
