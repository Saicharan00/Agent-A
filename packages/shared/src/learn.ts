// Learn area (F23): decision records (ADRs) and the owner's lesson journal with spaced review.
import { z } from 'zod';
import { DECISION_STATUSES, LESSON_SOURCES } from './enums';

export const decisionViewSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string(),
  contextMd: z.string(),
  optionsMd: z.string(),
  decisionMd: z.string(),
  consequencesMd: z.string(),
  status: z.enum(DECISION_STATUSES),
  taskId: z.string().nullable(),
  threadId: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  /** Where the record is exported, as bots see it: /shared/decisions/ADR-0001-<slug>.md. */
  path: z.string(),
});
export type DecisionView = z.infer<typeof decisionViewSchema>;

const md = z.string().max(20_000);

/** POST /api/decisions (the owner records one by hand; bots use record_decision). */
export const decisionCreateRequestSchema = z.object({
  title: z.string().trim().min(1).max(300),
  contextMd: md.default(''),
  optionsMd: md.default(''),
  decisionMd: md.default(''),
  consequencesMd: md.default(''),
  status: z.enum(DECISION_STATUSES).default('proposed'),
  taskId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
});
export type DecisionCreateRequest = z.input<typeof decisionCreateRequestSchema>;

/** PATCH /api/decisions/:id. */
export const decisionUpdateRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    contextMd: md,
    optionsMd: md,
    decisionMd: md,
    consequencesMd: md,
    status: z.enum(DECISION_STATUSES),
  })
  .partial();
export type DecisionUpdateRequest = z.infer<typeof decisionUpdateRequestSchema>;

export const decisionListQuerySchema = z.object({
  status: z.enum(DECISION_STATUSES).optional(),
  taskId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
});

export const lessonViewSchema = z.object({
  id: z.string(),
  topic: z.string(),
  lessonMd: z.string(),
  whyItMattersMd: z.string(),
  source: z.enum(LESSON_SOURCES),
  sourceId: z.string().nullable(),
  reviewedCount: z.number().int(),
  nextReviewAt: z.string().nullable(),
  createdAt: z.string(),
});
export type LessonView = z.infer<typeof lessonViewSchema>;

/** POST /api/lessons. */
export const lessonCreateRequestSchema = z.object({
  topic: z.string().trim().min(1).max(200),
  lessonMd: z.string().trim().min(1).max(20_000),
  whyItMattersMd: md.default(''),
});
export type LessonCreateRequest = z.input<typeof lessonCreateRequestSchema>;

/** PATCH /api/lessons/:id. */
export const lessonUpdateRequestSchema = z
  .object({
    topic: z.string().trim().min(1).max(200),
    lessonMd: z.string().trim().min(1).max(20_000),
    whyItMattersMd: md,
  })
  .partial();
export type LessonUpdateRequest = z.infer<typeof lessonUpdateRequestSchema>;

/** GET /api/lessons?topic=&due=1 (due: only lessons whose review is due now). */
export const lessonListQuerySchema = z.object({
  topic: z.string().trim().min(1).max(200).optional(),
  due: z.enum(['0', '1']).optional(),
});

export const LESSON_REVIEW_RESULTS = ['got_it', 'again'] as const;
export type LessonReviewResult = (typeof LESSON_REVIEW_RESULTS)[number];

/** POST /api/lessons/:id/review. */
export const lessonReviewRequestSchema = z.object({ result: z.enum(LESSON_REVIEW_RESULTS) });

/** Spaced review steps (PLAN F23): 1 day, 3 days, 7 days, then every 21 days. */
export const LESSON_REVIEW_DAYS = [1, 3, 7, 21] as const;

/**
 * The schedule after a review. `reviewedCount` counts "got it"s in a row: each one moves to the next step (the last
 * step repeats); "review again" starts over at 1 day.
 */
export function scheduleReview(
  reviewedCount: number,
  result: LessonReviewResult,
  now: Date = new Date(),
): { reviewedCount: number; nextReviewAt: string } {
  const count = result === 'got_it' ? reviewedCount + 1 : 0;
  const days = LESSON_REVIEW_DAYS[Math.min(Math.max(count - 1, 0), LESSON_REVIEW_DAYS.length - 1)]!;
  return { reviewedCount: count, nextReviewAt: new Date(now.getTime() + days * 86_400_000).toISOString() };
}

/** A decision or lesson was added or changed. Channel: `global`. */
export const liveLearnChangedSchema = z.object({
  type: z.literal('learn.changed'),
  kind: z.enum(['decision', 'lesson']),
  id: z.string(),
});
export type LiveLearnChanged = z.infer<typeof liveLearnChangedSchema>;
