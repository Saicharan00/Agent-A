import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Decision, type Lesson, type Repos, slugify } from '@agenta/db';
import {
  type DecisionCreateRequest,
  type DecisionStatus,
  type DecisionUpdateRequest,
  type DecisionView,
  type LessonCreateRequest,
  type LessonReviewResult,
  type LessonSource,
  type LessonUpdateRequest,
  type LessonView,
  type HandoffBrief,
  type LearnRequestResponse,
  type LiveLearnChanged,
  WORK_SPLIT_TARGET,
  type WorkSplit,
  type CarryOverBriefRequest,
  carryOverBriefRequestSchema,
  decisionCreateRequestSchema,
  checkConfidential,
  describeFindings,
  lessonCreateRequestSchema,
  lessonViewSchema,
  scheduleReview,
  weekStart,
} from '@agenta/shared';
import type { EventBus } from '../bus';
import type { ThreadService } from '../threads/service';

type Log = { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };

export class LearnError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export type LearnServiceOptions = {
  repos: Repos;
  bus?: EventBus;
  log?: Log;
  /** Host folder mounted at /shared: decisions are exported to <sharedDir>/decisions/ADR-0001-<slug>.md. */
  sharedDir?: string;
  /** Posts the owner's request to Agent A (weekly review, carry-over brief). */
  threads?: Pick<ThreadService, 'askLead'>;
  now?: () => Date;
};

const DAY = 86_400_000;
const BRIEF_ADVICE = 'Briefs must not hold secrets or confidential material: rewrite it without them.';

const adrPrefix = (n: number) => `ADR-${String(n).padStart(4, '0')}-`;
export const decisionFileName = (d: Pick<Decision, 'number' | 'title'>) =>
  `${adrPrefix(d.number)}${slugify(d.title) || 'decision'}.md`;

export function toDecisionView(d: Decision): DecisionView {
  return { ...d, path: `/shared/decisions/${decisionFileName(d)}` };
}
export const toLessonView = (l: Lesson): LessonView => lessonViewSchema.parse(l);

/** The exported ADR (Michael Nygard's layout). */
export function renderDecision(d: Decision): string {
  const section = (title: string, body: string) => `## ${title}\n\n${body.trim() || '_None recorded._'}\n`;
  return [
    `# ${adrPrefix(d.number).slice(0, -1)}: ${d.title}\n`,
    `- Status: ${d.status}`,
    `- Date: ${d.createdAt.slice(0, 10)}`,
    ...(d.taskId ? [`- Task: ${d.taskId}`] : []),
    ...(d.threadId ? [`- Thread: ${d.threadId}`] : []),
    '',
    section('Context', d.contextMd),
    section('Options considered', d.optionsMd),
    section('Decision', d.decisionMd),
    section('Consequences', d.consequencesMd),
  ].join('\n');
}

/**
 * Decisions and lessons (PLAN F23). The owner's API and the bots' record_decision / add_lesson tools both go through
 * here, so every decision is exported to /shared/decisions and clients hear `learn.changed`.
 */
export class LearnService {
  constructor(private readonly opts: LearnServiceOptions) {}

  private now = () => this.opts.now?.() ?? new Date();

  listDecisions(opts: { status?: DecisionStatus; taskId?: string; threadId?: string } = {}): DecisionView[] {
    return this.opts.repos.decisions.list(opts).map(toDecisionView);
  }

  getDecision(id: string): DecisionView {
    return toDecisionView(this.decision(id));
  }

  createDecision(input: DecisionCreateRequest, createdBy = 'user'): DecisionView {
    const req = decisionCreateRequestSchema.parse(input);
    const { repos } = this.opts;
    if (req.taskId && !repos.tasks.get(req.taskId))
      throw new LearnError('task_not_found', `Task ${req.taskId} not found`, 404);
    if (req.threadId && !repos.threads.get(req.threadId))
      throw new LearnError('thread_not_found', `Thread ${req.threadId} not found`, 404);
    const d = repos.decisions.create({
      ...req,
      taskId: req.taskId ?? null,
      threadId: req.threadId ?? null,
      createdBy,
    });
    this.export(d);
    this.changed('decision', d.id);
    this.opts.log?.info({ decisionId: d.id, number: d.number }, 'decision recorded');
    return toDecisionView(d);
  }

  updateDecision(id: string, patch: DecisionUpdateRequest): DecisionView {
    const before = this.decision(id);
    const d = this.opts.repos.decisions.update(id, patch) ?? before;
    this.export(d);
    this.changed('decision', d.id);
    return toDecisionView(d);
  }

  listLessons(opts: { topic?: string; due?: boolean } = {}): LessonView[] {
    const { lessons } = this.opts.repos;
    if (opts.due) {
      const due = lessons.listDue(this.now().toISOString());
      return (opts.topic ? due.filter((l) => l.topic === opts.topic) : due).map(toLessonView);
    }
    return lessons.list({ topic: opts.topic }).map(toLessonView);
  }

  /** New lessons are first due for review a day later. */
  createLesson(
    input: LessonCreateRequest,
    source: { source: LessonSource; sourceId: string | null } = { source: 'manual', sourceId: null },
    opts: { dueNow?: boolean } = {},
  ): LessonView {
    const req = lessonCreateRequestSchema.parse(input);
    const nextReviewAt = opts.dueNow
      ? this.now().toISOString()
      : scheduleReview(0, 'again', this.now()).nextReviewAt;
    const l = this.opts.repos.lessons.create({ ...req, ...source, nextReviewAt });
    this.changed('lesson', l.id);
    return toLessonView(l);
  }

  updateLesson(id: string, patch: LessonUpdateRequest): LessonView {
    const before = this.lesson(id);
    const l = this.opts.repos.lessons.update(id, patch) ?? before;
    this.changed('lesson', l.id);
    return toLessonView(l);
  }

  /** "Got it" moves the lesson to the next review step (1d → 3d → 7d → 21d); "review again" goes back to 1 day. */
  reviewLesson(id: string, result: LessonReviewResult): LessonView {
    const before = this.lesson(id);
    const l =
      this.opts.repos.lessons.update(id, scheduleReview(before.reviewedCount, result, this.now())) ?? before;
    this.changed('lesson', l.id);
    return toLessonView(l);
  }

  deleteLesson(id: string): void {
    this.lesson(id);
    this.opts.repos.lessons.delete(id);
    this.changed('lesson', id);
  }

  /** Done tasks by who executed them, per UTC week (Monday), the last `weeks` weeks oldest first. */
  workSplit(weeks = 8): WorkSplit {
    const current = weekStart(this.now()).getTime();
    const starts = Array.from({ length: weeks }, (_, i) => current - (weeks - 1 - i) * 7 * DAY);
    const rows = starts.map((t) => ({ weekStart: new Date(t).toISOString(), agent: 0, human: 0, mixed: 0 }));
    for (const task of this.opts.repos.tasks.list({ status: 'done' })) {
      const i = starts.indexOf(weekStart(new Date(task.updatedAt)).getTime());
      if (i >= 0) rows[i]![task.executedBy] += 1;
    }
    return {
      target: WORK_SPLIT_TARGET,
      weeks: rows.map((r) => {
        const total = r.agent + r.human + r.mixed;
        return { ...r, agentShare: total ? (r.agent + r.mixed / 2) / total : null };
      }),
    };
  }

  /** Asks Agent A (in its DM) for the weekly review: a summary, the owner's growth areas and 5 review questions. */
  weeklyReview(): LearnRequestResponse {
    const { repos } = this.opts;
    const since = new Date(this.now().getTime() - 7 * DAY).toISOString();
    const recent = <T extends { createdAt: string }>(xs: T[]) => xs.filter((x) => x.createdAt >= since);
    const goals = repos.goals.list().filter((g) => g.updatedAt >= since);
    const done = repos.tasks.list({ status: 'done' }).filter((t) => t.updatedAt >= since);
    const decisions = recent(repos.decisions.list());
    const lessons = recent(repos.lessons.list());
    const split = this.workSplit(1).weeks[0]!;
    const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- (none)');
    const content = [
      '## Weekly review',
      'Please write my weekly review of the last 7 days: what we achieved, the decisions and why they matter, what I ' +
        'learned, and my growth areas as a future lead (be specific and honest). Then add exactly 5 review ' +
        'questions that test what I should remember, each with `add_lesson` (topic "weekly-review", the question ' +
        'and its answer in `lesson`, `review_today: true`).',
      `### Goals\n${list(goals.map((g) => `${g.title} (${g.status})`))}`,
      `### Tasks done\n${list(done.map((t) => `${t.title} (executed by ${t.executedBy})`))}`,
      `### Decisions\n${list(decisions.map((d) => `ADR-${String(d.number).padStart(4, '0')} ${d.title} (${d.status})`))}`,
      `### Lessons\n${list(lessons.map((l) => `${l.topic}: ${l.lessonMd.split('\n')[0]}`))}`,
      `### Work split this week\nagent ${split.agent} · mixed ${split.mixed} · human ${split.human} (target: bots do ${WORK_SPLIT_TARGET * 100}%)`,
    ].join('\n\n');
    return this.ask(null, content);
  }

  /** Asks Agent A for a carry-over brief of a task or goal, posted in that task's or goal's thread. */
  carryOverBrief(body: CarryOverBriefRequest): LearnRequestResponse {
    const req = carryOverBriefRequestSchema.parse(body);
    const { repos } = this.opts;
    let threadId: string | null;
    let about: string;
    if (req.taskId) {
      const t = repos.tasks.get(req.taskId);
      if (!t) throw new LearnError('task_not_found', `Task ${req.taskId} not found`, 404);
      threadId = t.taskThreadId ?? t.originThreadId;
      about = [
        `the task "${t.title}" (${t.status})`,
        t.descriptionMd.trim() && `### Description\n${t.descriptionMd.trim()}`,
        t.acceptanceMd.trim() && `### Acceptance criteria\n${t.acceptanceMd.trim()}`,
        t.resultSummaryMd?.trim() && `### Result so far\n${t.resultSummaryMd.trim()}`,
      ]
        .filter(Boolean)
        .join('\n\n');
    } else {
      const g = repos.goals.get(req.goalId!);
      if (!g) throw new LearnError('goal_not_found', `Goal ${req.goalId} not found`, 404);
      threadId = g.threadId;
      about = [`the goal "${g.title}" (${g.status})`, `### Goal\n${g.goalMd.trim()}`].join('\n\n');
    }
    const content = [
      `## Carry-over brief\nWrite a short carry-over brief for ${about}`,
      'I will redo this on another machine by hand, so the brief must stand alone: **What to do**, **Steps**, ' +
        '**Checks** and **Risks**, a page at most. Sanitize it: no secrets, keys, internal hostnames, company, ' +
        `client or people names. Save it with \`save_handoff_brief\`.`,
    ].join('\n\n');
    // A thread that no longer exists or is archived falls back to Agent A's DM.
    const usable = threadId && repos.threads.get(threadId)?.archivedAt === null ? threadId : null;
    return this.ask(usable, content);
  }

  /** save_handoff_brief: guard-checked, then written to /shared/handoff/<date>-<slug>.md. */
  saveBrief(input: { title: string; contentMd: string }): HandoffBrief {
    const findings = this.confidential(`${input.title}\n${input.contentMd}`);
    if (findings.length) {
      this.opts.log?.warn({ kinds: findings.map((f) => f.kind) }, 'brief rejected: confidential');
      throw new LearnError('secret_detected', describeFindings(findings, BRIEF_ADVICE), 422);
    }
    const dir = this.handoffDir();
    mkdirSync(dir, { recursive: true });
    const name = `${this.now().toISOString().slice(0, 10)}-${slugify(input.title) || 'brief'}.md`;
    const path = join(dir, name);
    writeFileSync(`${path}.tmp`, `# ${input.title.trim()}\n\n${input.contentMd.trim()}\n`);
    renameSync(`${path}.tmp`, path);
    this.changed('brief', name);
    return this.readBrief(name);
  }

  /** Briefs in /shared/handoff, newest first; each is re-checked and withheld if it now looks confidential. */
  listBriefs(): HandoffBrief[] {
    let names: string[];
    try {
      names = readdirSync(this.handoffDir()).filter((f) => f.endsWith('.md'));
    } catch {
      return [];
    }
    return names.map((n) => this.readBrief(n)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private readBrief(name: string): HandoffBrief {
    const file = join(this.handoffDir(), name);
    const text = readFileSync(file, 'utf8');
    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? name.replace(/\.md$/, '');
    const findings = this.confidential(text);
    return {
      name,
      path: `/shared/handoff/${name}`,
      title,
      contentMd: findings.length ? '' : text,
      updatedAt: statSync(file).mtime.toISOString(),
      guard: findings.length ? { ok: false, reason: describeFindings(findings, BRIEF_ADVICE) } : { ok: true },
    };
  }

  private confidential(text: string) {
    return checkConfidential(text, this.opts.repos.guardTerms.list());
  }

  private handoffDir(): string {
    if (!this.opts.sharedDir)
      throw new LearnError('no_shared_dir', 'The shared folder is not configured', 500);
    return join(this.opts.sharedDir, 'handoff');
  }

  private ask(threadId: string | null, content: string): LearnRequestResponse {
    if (!this.opts.threads) throw new LearnError('unavailable', 'Chat is not available', 503);
    try {
      const res = this.opts.threads.askLead(threadId, content);
      return { threadId: res.message.threadId, runId: res.runs[0]!.id };
    } catch (err) {
      // Thread/run errors (no lead, goal paused…) keep their code and status.
      const e = err as Error & { code?: unknown; statusCode?: unknown };
      if (typeof e.code === 'string' && typeof e.statusCode === 'number')
        throw new LearnError(e.code, e.message, e.statusCode);
      throw err;
    }
  }

  private decision(id: string): Decision {
    const d = this.opts.repos.decisions.get(id);
    if (!d) throw new LearnError('not_found', `Decision ${id} not found`, 404);
    return d;
  }

  private lesson(id: string): Lesson {
    const l = this.opts.repos.lessons.get(id);
    if (!l) throw new LearnError('not_found', `Lesson ${id} not found`, 404);
    return l;
  }

  private changed(kind: LiveLearnChanged['kind'], id: string): void {
    const event: LiveLearnChanged = { type: 'learn.changed', kind, id };
    this.opts.bus?.publish('global', event);
  }

  /** One file per decision; a renamed decision's old file is replaced. */
  private export(d: Decision): void {
    if (!this.opts.sharedDir) return;
    const dir = join(this.opts.sharedDir, 'decisions');
    try {
      mkdirSync(dir, { recursive: true });
      const name = decisionFileName(d);
      for (const f of readdirSync(dir))
        if (f.startsWith(adrPrefix(d.number)) && f !== name) rmSync(join(dir, f), { force: true });
      const path = join(dir, name);
      writeFileSync(`${path}.tmp`, renderDecision(d));
      renameSync(`${path}.tmp`, path);
    } catch (err) {
      // The DB is the source of truth; a failed export must not fail the save.
      this.opts.log?.warn({ err, decisionId: d.id }, 'could not export decision');
    }
  }
}
