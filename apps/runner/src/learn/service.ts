import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  type LiveLearnChanged,
  decisionCreateRequestSchema,
  lessonCreateRequestSchema,
  lessonViewSchema,
  scheduleReview,
} from '@agenta/shared';
import type { EventBus } from '../bus';

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
  now?: () => Date;
};

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
  ): LessonView {
    const req = lessonCreateRequestSchema.parse(input);
    const first = scheduleReview(0, 'again', this.now());
    const l = this.opts.repos.lessons.create({ ...req, ...source, nextReviewAt: first.nextReviewAt });
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
