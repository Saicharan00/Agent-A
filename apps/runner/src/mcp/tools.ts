import type { Bot, Repos, Run, Task } from '@agenta/db';
import {
  MAX_REVISION_ROUNDS,
  PLATFORM_TOOL_PREFIX,
  type PlatformToolInput,
  type PlatformToolName,
  platformToolInputs,
} from '@agenta/shared';
import { z } from 'zod';
import type { EventBus } from '../bus';
import type { GoalService } from '../goals/service';
import { MemoryError, MemoryService } from '../memories/service';
import { publishTaskChanged, type TaskService } from '../tasks/service';
import type { ThreadService } from '../threads/service';

type Log = { info(obj: object, msg?: string): void; debug(obj: object, msg?: string): void };

/** A tool call the platform refused; `message` is shown to the calling bot. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const PLATFORM_TOOL_DESCRIPTIONS: Record<PlatformToolName, string> = {
  whoami: 'Who you are on the team: your id, handle, role, whether you lead, and your current run.',
  list_bots: 'Your teammates (and you): handle, name, role, engine and whether their computer is running.',
  list_threads: 'The conversations you are a member of (direct messages with the owner and group chats).',
  read_thread: 'The latest messages of a thread you are a member of, oldest first.',
  post_message: 'Post a message as yourself in a thread you are a member of.',
  ask_bot:
    'Ask a teammate to do something. Posts your message in their thread (default: their direct messages with ' +
    'the owner) and starts their turn. Returns at once with a run id; check it later with get_run_status.',
  get_run_status: "A run's status and, once it has finished, the bot's reply.",
  save_memory:
    'Save something worth remembering: scope "bot" is only for you, "shared" is for the whole team. ' +
    'Never save secrets.',
  search_memory: 'Search your memories and the team’s shared memories by keywords.',
  create_task:
    'Create a task on the team board. Specialists create tasks (and sub-tasks of their own tasks) for ' +
    'themselves; only the lead assigns work to others.',
  list_tasks: 'Tasks on the board, most recently updated first, filtered by status, assignee or parent task.',
  get_task: 'A task with its sub-tasks and timeline.',
  update_task: 'Move your task to todo, in_progress or blocked, and/or add a progress note.',
  submit_task_result: 'Hand in your work on a task for review (status becomes in_review).',
  review_task:
    'Lead only: approve a task in review (done) or request changes (changes_requested) with feedback.',
  record_decision:
    'Record a design decision (context, options, decision, consequences) for the team and the owner.',
  add_lesson: 'Add a lesson for the owner to learn from: what happened and why it matters.',
  request_approval:
    'Ask the owner before a risky action (pushing, deleting, spending, contacting people). Returns at once ' +
    'with an approval id; do not act until check_approval says approved.',
  check_approval: 'The status of one of your approval requests: pending, approved, denied or expired.',
  notify_owner: 'Send the owner a notification (keep it for things they should see soon).',
};

const MAX_REPLY_CHARS = 20_000;
const MAX_MEMORY_CHARS = 2_000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (truncated)` : s);

type Handlers = { [N in PlatformToolName]: (bot: Bot, input: PlatformToolInput<N>) => unknown };

export type PlatformToolsOptions = {
  repos: Repos;
  threads: Pick<ThreadService, 'postAsBot' | 'askBot'>;
  /** Live `task.changed` events for the board (F19). */
  bus?: EventBus;
  log: Log;
  /** Starts tasks the lead assigns within a goal, and sends reviewed work back (F20). */
  tasks?: Pick<TaskService, 'start'>;
  /** The goal loop: reviews of handed-in work and escalations to the owner (F20). */
  goals?: Pick<GoalService, 'onSubmitted' | 'escalate'>;
  /** save_memory/search_memory (F22); default: one without a /shared mirror or live events. */
  memories?: MemoryService;
};

/**
 * The Platform MCP tools (PLAN F17), independent of the transport: the MCP server and the mock engine both call
 * `call(bot, name, input)`. The calling bot is always the authenticated one; results are plain JSON objects.
 */
export class PlatformTools {
  private readonly memories: MemoryService;

  constructor(private readonly opts: PlatformToolsOptions) {
    this.memories = opts.memories ?? new MemoryService({ repos: opts.repos });
  }

  /** The turn the bot is in now (a bot runs one turn at a time), so calls can be tied to it. */
  currentRun(botId: string): Run | undefined {
    return this.opts.repos.runs.list({ botId, status: 'running', limit: 1 })[0];
  }

  async call(bot: Bot, name: string, input: unknown): Promise<unknown> {
    const tool = name.startsWith(PLATFORM_TOOL_PREFIX) ? name.slice(PLATFORM_TOOL_PREFIX.length) : name;
    if (!Object.hasOwn(platformToolInputs, tool)) throw new ToolError('unknown_tool', `Unknown tool ${name}`);
    const key = tool as PlatformToolName;
    const parsed = platformToolInputs[key].safeParse(input ?? {});
    if (!parsed.success)
      throw new ToolError('invalid_input', `Invalid input: ${z.prettifyError(parsed.error)}`);
    this.opts.log.info({ botId: bot.id, tool: key }, 'platform tool call');
    this.opts.log.debug({ botId: bot.id, tool: key, input: parsed.data }, 'platform tool input');
    const handler = this.handlers[key] as (bot: Bot, input: unknown) => unknown;
    return handler(bot, parsed.data);
  }

  private bot(ref: string): Bot {
    const { bots } = this.opts.repos;
    const bot = bots.getBySlug(ref.replace(/^@/, '').toLowerCase()) ?? bots.get(ref);
    if (!bot) throw new ToolError('bot_not_found', `No teammate called ${ref}; see list_bots`);
    return bot;
  }

  /** "self" or a handle/id; archived bots can't take work. */
  private assignee(caller: Bot, ref: string): Bot {
    const bot = ref === 'self' ? caller : this.bot(ref);
    if (bot.archivedAt) throw new ToolError('bot_archived', `${bot.name} is archived`);
    return bot;
  }

  private task(id: string): Task {
    const task = this.opts.repos.tasks.get(id);
    if (!task) throw new ToolError('task_not_found', `Task ${id} not found`);
    return task;
  }

  /** Assignee, creator or lead: who may move a task or add notes to it. */
  private mayWorkOn(bot: Bot, task: Task): boolean {
    return bot.isLead || task.assigneeBotId === bot.id || task.createdBy === bot.id;
  }

  private taskView(t: Task) {
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      assignee: t.assigneeBotId ? this.handle(t.assigneeBotId) : null,
      created_by: t.createdBy === 'user' ? 'owner' : this.handle(t.createdBy),
      parent_task_id: t.parentTaskId,
      revision_count: t.revisionCount,
      updated_at: t.updatedAt,
    };
  }

  private event(task: Task, bot: Bot, kind: string, payload: Record<string, unknown> = {}): void {
    this.opts.repos.tasks.addEvent({ taskId: task.id, kind, actor: bot.id, payload });
    // Every task change made by a tool writes an event, so this is where the board hears about it.
    if (this.opts.bus) publishTaskChanged(this.opts.bus, task.id);
  }

  private handle(botId: string | null): string {
    return (botId && this.opts.repos.bots.get(botId)?.slug) ?? 'former-teammate';
  }

  private readonly handlers: Handlers = {
    whoami: (bot) => ({
      id: bot.id,
      handle: bot.slug,
      name: bot.name,
      role: bot.role,
      is_lead: bot.isLead,
      engine: bot.engine,
      dm_thread_id: this.opts.repos.threads.findDm(bot.id)?.id ?? null,
      current_run_id: this.currentRun(bot.id)?.id ?? null,
    }),

    list_bots: (bot) =>
      this.opts.repos.bots.list().map((b) => ({
        id: b.id,
        handle: b.slug,
        name: b.name,
        role: b.role,
        is_lead: b.isLead,
        engine: b.engine,
        computer: b.status,
        ...(b.id === bot.id ? { you: true } : {}),
      })),

    list_threads: (bot) =>
      this.opts.repos.threads.list({ botId: bot.id }).map((t) => ({
        id: t.id,
        kind: t.kind,
        title: t.title,
        members: this.opts.repos.threads.listMembers(t.id).map((b) => b.slug),
        updated_at: t.updatedAt,
      })),

    read_thread: (bot, { thread_id, limit }) => {
      const { repos } = this.opts;
      const thread = repos.threads.get(thread_id);
      if (!thread || !repos.threads.isMember(thread_id, bot.id)) {
        throw new ToolError('thread_not_found', `No thread ${thread_id} that you are a member of`);
      }
      return {
        id: thread.id,
        kind: thread.kind,
        title: thread.title,
        messages: repos.messages.listByThread(thread_id, { limit }).map((m) => ({
          id: m.id,
          author:
            m.authorType === 'user'
              ? 'owner'
              : m.authorType === 'system'
                ? 'system'
                : this.handle(m.authorBotId),
          at: m.createdAt,
          text: m.contentMd,
        })),
      };
    },

    post_message: (bot, { thread_id, text }) => {
      const m = this.opts.threads.postAsBot(bot, thread_id, text, this.currentRun(bot.id));
      return { message_id: m.id, thread_id: m.threadId };
    },

    ask_bot: (bot, { bot: ref, message, thread_id }) => {
      const target = this.bot(ref);
      const { message: m, run } = this.opts.threads.askBot(bot, target, message, {
        threadId: thread_id,
        parentRun: this.currentRun(bot.id),
      });
      return {
        run_id: run.id,
        status: run.status,
        thread_id: m.threadId,
        message_id: m.id,
        bot: target.slug,
      };
    },

    get_run_status: (_bot, { run_id }) => {
      const { repos } = this.opts;
      const run = repos.runs.get(run_id);
      if (!run) throw new ToolError('run_not_found', `Run ${run_id} not found`);
      const reply = repos.messages.getByRun(run.id)?.contentMd;
      return {
        id: run.id,
        bot: this.handle(run.botId),
        status: run.status,
        trigger: run.trigger,
        thread_id: run.threadId,
        created_at: run.createdAt,
        started_at: run.startedAt,
        finished_at: run.finishedAt,
        error: run.error,
        reply: reply === undefined ? null : clip(reply, MAX_REPLY_CHARS),
      };
    },

    save_memory: (bot, { title, content, scope, tags }) => {
      try {
        const m = this.memories.create(
          { scope, botId: scope === 'bot' ? bot.id : undefined, title, contentMd: content, tags },
          this.currentRun(bot.id)?.id ?? null,
        );
        return { id: m.id, scope: m.scope, title: m.title };
      } catch (err) {
        if (err instanceof MemoryError) throw new ToolError(err.code, err.message);
        throw err;
      }
    },

    search_memory: (bot, { query, scope, limit }) =>
      this.memories.search(bot.id, query, scope, limit).map((m) => ({
        id: m.id,
        scope: m.scope,
        title: m.title,
        content: clip(m.contentMd, MAX_MEMORY_CHARS),
        tags: m.tags,
        updated_at: m.updatedAt,
      })),

    create_task: (bot, input) => {
      const { repos } = this.opts;
      const assignee =
        input.assignee !== undefined ? this.assignee(bot, input.assignee) : bot.isLead ? null : bot;
      if (!bot.isLead && assignee?.id !== bot.id) {
        throw new ToolError(
          'lead_only',
          'Only the lead assigns tasks to others; ask_bot your teammate instead',
        );
      }
      if (input.parent_task_id) {
        const parent = this.task(input.parent_task_id);
        if (!bot.isLead && parent.assigneeBotId !== bot.id) {
          throw new ToolError('forbidden', 'You can only add sub-tasks to tasks assigned to you');
        }
      }
      const run = this.currentRun(bot.id);
      // Tasks created during a goal's turn belong to the goal, within its guardrails (F20).
      const goal = run?.goalId ? repos.goals.get(run.goalId) : undefined;
      if (goal) {
        if (goal.pausedAt) throw new ToolError('goal_paused', 'The owner paused this goal; wait for them');
        if (bot.isLead && !goal.confirmedAt && !goal.autoRun) {
          throw new ToolError(
            'plan_not_confirmed',
            'The owner has not confirmed the plan yet: post the plan and wait for their confirmation',
          );
        }
        if (repos.goals.listTasks(goal.id).length >= goal.maxTasks) {
          throw new ToolError(
            'goal_task_limit',
            `This goal already has its maximum of ${goal.maxTasks} tasks`,
          );
        }
      }
      const task = repos.tasks.create({
        title: input.title,
        descriptionMd: input.description,
        acceptanceMd: input.acceptance,
        priority: input.priority,
        assigneeBotId: assignee?.id ?? null,
        createdBy: bot.id,
        parentTaskId: input.parent_task_id ?? null,
        originThreadId: run?.threadId ?? null,
        goalId: goal?.id ?? null,
      });
      this.event(task, bot, 'created', { assignee: task.assigneeBotId, runId: run?.id ?? null });
      // The lead's goal tasks start at once in their task threads.
      if (goal && bot.isLead && task.assigneeBotId && this.opts.tasks) {
        try {
          this.opts.tasks.start(task.id);
        } catch (err) {
          return { ...this.taskView(this.task(task.id)), not_started: (err as Error).message };
        }
      }
      return this.taskView(this.task(task.id));
    },

    list_tasks: (bot, { status, assignee, parent_task_id, limit }) =>
      this.opts.repos.tasks
        .list({
          status,
          assigneeBotId: assignee ? this.assignee(bot, assignee).id : undefined,
          parentTaskId: parent_task_id,
        })
        .slice(0, limit)
        .map((t) => this.taskView(t)),

    get_task: (_bot, { id }) => {
      const { repos } = this.opts;
      const task = this.task(id);
      return {
        ...this.taskView(task),
        description: task.descriptionMd,
        acceptance: task.acceptanceMd,
        result_summary: task.resultSummaryMd,
        artifacts: task.artifacts,
        subtasks: repos.tasks.list({ parentTaskId: task.id }).map((t) => this.taskView(t)),
        timeline: repos.tasks.listEvents(task.id).map((e) => ({
          kind: e.kind,
          by: e.actor === 'user' ? 'owner' : this.handle(e.actor),
          at: e.createdAt,
          ...e.payload,
        })),
      };
    },

    update_task: (bot, { id, status, note }) => {
      const task = this.task(id);
      if (!this.mayWorkOn(bot, task)) {
        throw new ToolError('forbidden', 'Only its assignee, its creator or the lead can update this task');
      }
      if (status === undefined && note === undefined)
        throw new ToolError('invalid_input', 'Give a status or a note');
      if (status && task.status === 'done') throw new ToolError('task_done', 'This task is done');
      const updated = status ? this.opts.repos.tasks.update(id, { status })! : task;
      if (status && status !== task.status)
        this.event(task, bot, 'status', { from: task.status, to: status });
      if (note) this.event(task, bot, 'note', { note });
      return this.taskView(updated);
    },

    submit_task_result: (bot, { id, summary, artifacts }) => {
      const task = this.task(id);
      if (task.assigneeBotId !== bot.id && !bot.isLead) {
        throw new ToolError('forbidden', 'Only the assignee can hand in this task');
      }
      if (task.status === 'done') throw new ToolError('task_done', 'This task is done');
      const updated = this.opts.repos.tasks.update(id, {
        status: 'in_review',
        resultSummaryMd: summary,
        artifacts,
      })!;
      this.event(task, bot, 'submitted', { summary, artifacts, runId: this.currentRun(bot.id)?.id ?? null });
      // In a goal, the lead reviews it next.
      this.opts.goals?.onSubmitted(updated);
      return this.taskView(updated);
    },

    review_task: (bot, { id, verdict, feedback }) => {
      if (!bot.isLead) throw new ToolError('lead_only', 'Only the lead reviews tasks');
      const task = this.task(id);
      if (task.status !== 'in_review') {
        throw new ToolError('not_in_review', `Task ${id} is ${task.status}, not in_review`);
      }
      // After MAX_REVISION_ROUNDS rounds of changes the owner decides; the task stays in review for them.
      if (verdict === 'request_changes' && task.revisionCount >= MAX_REVISION_ROUNDS) {
        this.event(task, bot, 'escalated', { feedback });
        this.opts.goals?.escalate(task, bot, feedback);
        return {
          ...this.taskView(task),
          escalated: true,
          note: `${MAX_REVISION_ROUNDS} rounds of changes already: the owner decides on this task now.`,
        };
      }
      const updated = this.opts.repos.tasks.update(
        id,
        verdict === 'approve'
          ? { status: 'done' }
          : { status: 'changes_requested', revisionCount: task.revisionCount + 1 },
      )!;
      this.event(task, bot, 'reviewed', { verdict, feedback });
      // The assignee's next turn starts with the feedback (as when the owner requests changes).
      if (
        verdict === 'request_changes' &&
        updated.assigneeBotId &&
        updated.assigneeBotId !== bot.id &&
        updated.executedBy !== 'human' &&
        this.opts.tasks
      ) {
        try {
          this.opts.tasks.start(id, `Changes requested by ${bot.name}:\n\n${feedback}`, {
            queueBehind: true,
          });
        } catch (err) {
          return { ...this.taskView(this.task(id)), not_restarted: (err as Error).message };
        }
      }
      return this.taskView(this.task(id));
    },

    record_decision: (bot, input) => {
      if (input.task_id) this.task(input.task_id);
      const d = this.opts.repos.decisions.create({
        title: input.title,
        contextMd: input.context,
        optionsMd: input.options,
        decisionMd: input.decision,
        consequencesMd: input.consequences,
        status: input.status,
        taskId: input.task_id ?? null,
        threadId: this.currentRun(bot.id)?.threadId ?? null,
        createdBy: bot.id,
      });
      if (input.task_id)
        this.event(this.task(input.task_id), bot, 'decision', { decisionId: d.id, title: d.title });
      return { id: d.id, title: d.title, status: d.status };
    },

    add_lesson: (bot, input) => {
      if (input.task_id) this.task(input.task_id);
      const runId = this.currentRun(bot.id)?.id ?? null;
      const l = this.opts.repos.lessons.create({
        topic: input.topic,
        lessonMd: input.lesson,
        whyItMattersMd: input.why_it_matters,
        source: input.task_id ? 'task' : runId ? 'run' : 'manual',
        sourceId: input.task_id ?? runId,
      });
      return { id: l.id, topic: l.topic };
    },

    request_approval: (bot, { action, details, risk }) => {
      const { repos } = this.opts;
      const a = repos.approvals.create({
        botId: bot.id,
        runId: this.currentRun(bot.id)?.id ?? null,
        action,
        detailsMd: details,
        risk,
      });
      repos.notifications.create({
        kind: 'approval.requested',
        title: `${bot.name} asks to: ${action}`,
        body: `Risk: ${risk}. ${details}`.slice(0, 2_000),
        link: '/',
      });
      return { approval_id: a.id, status: a.status };
    },

    check_approval: (bot, { approval_id }) => {
      const a = this.opts.repos.approvals.get(approval_id);
      if (!a || a.botId !== bot.id)
        throw new ToolError('approval_not_found', `No approval ${approval_id} of yours`);
      return { approval_id: a.id, action: a.action, status: a.status, decided_at: a.decidedAt };
    },

    notify_owner: (bot, { title, body }) => {
      const n = this.opts.repos.notifications.create({
        kind: 'bot.notice',
        title: `${bot.name}: ${title}`,
        body,
        link: `/bots/${bot.id}`,
      });
      return { notification_id: n.id };
    },
  };
}
