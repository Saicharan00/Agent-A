// Memories, decisions and lessons: the team's knowledge and the owner's learning record.
import {
  type DecisionCreateInput,
  type DecisionStatus,
  type DecisionUpdateInput,
  type LessonCreateInput,
  type LessonUpdateInput,
  type MemoryCreateInput,
  type MemoryScope,
  type MemoryUpdateInput,
  decisionCreateSchema,
  decisionUpdateSchema,
  lessonCreateSchema,
  lessonUpdateSchema,
  memoryCreateSchema,
  memoryUpdateSchema,
  newId,
  nowIso,
} from '@agenta/shared';
import { and, asc, desc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { type Decision, type Lesson, type Memory, decisions, lessons, memories } from '../schema';
import { definedOnly, isEmpty } from './util';

export function makeMemoriesRepo(db: Db) {
  return {
    create(input: MemoryCreateInput): Memory {
      const data = memoryCreateSchema.parse(input);
      const ts = nowIso();
      return db
        .insert(memories)
        .values({ ...data, id: newId('memory'), createdAt: ts, updatedAt: ts })
        .returning()
        .get();
    },

    get(id: string): Memory | undefined {
      return db.select().from(memories).where(eq(memories.id, id)).get();
    },

    /** Pinned first, then most recently updated first. */
    list(opts: { scope?: MemoryScope; botId?: string; tag?: string } = {}): Memory[] {
      return db
        .select()
        .from(memories)
        .where(
          and(
            opts.scope ? eq(memories.scope, opts.scope) : undefined,
            opts.botId ? eq(memories.botId, opts.botId) : undefined,
            opts.tag
              ? sql`exists (select 1 from json_each(${memories.tags}) where json_each.value = ${opts.tag})`
              : undefined,
          ),
        )
        .orderBy(desc(memories.pinned), desc(memories.updatedAt))
        .all();
    },

    update(id: string, input: MemoryUpdateInput): Memory | undefined {
      const patch = definedOnly(memoryUpdateSchema.parse(input));
      return db
        .update(memories)
        .set({ ...patch, updatedAt: nowIso() })
        .where(eq(memories.id, id))
        .returning()
        .get();
    },

    delete(id: string): boolean {
      return db.delete(memories).where(eq(memories.id, id)).run().changes > 0;
    },

    /**
     * Full-text search (SQLite FTS5, porter stemming), best match first; a title match weighs double.
     * Each query word is matched as a prefix and any word may match. `botId` limits bot-scoped memories to that bot.
     */
    search(query: string, opts: { scope?: MemoryScope; botId?: string; limit?: number } = {}): Memory[] {
      const words = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
      if (!words.length) return [];
      // Quoting each word keeps FTS5 syntax (AND, NEAR, column:, quotes) in the query from being interpreted.
      const match = words.map((w) => `"${w}"*`).join(' OR ');
      return db
        .select({ m: memories })
        .from(memories)
        .innerJoin(sql`memories_fts`, sql`memories_fts.rowid = ${memories}.rowid`)
        .where(
          and(
            sql`memories_fts match ${match}`,
            opts.scope ? eq(memories.scope, opts.scope) : undefined,
            opts.botId ? sql`(${memories.scope} = 'shared' or ${memories.botId} = ${opts.botId})` : undefined,
          ),
        )
        .orderBy(sql`bm25(memories_fts, 2.0, 1.0, 1.0)`, desc(memories.updatedAt))
        .limit(opts.limit ?? 20)
        .all()
        .map((r) => r.m);
    },
  };
}
export type MemoriesRepo = ReturnType<typeof makeMemoriesRepo>;

export function makeDecisionsRepo(db: Db) {
  return {
    create(input: DecisionCreateInput): Decision {
      const data = decisionCreateSchema.parse(input);
      // Synchronous driver, one process: max+1 cannot race.
      const last = db
        .select({ n: sql<number>`coalesce(max(${decisions.number}), 0)` })
        .from(decisions)
        .get();
      return db
        .insert(decisions)
        .values({ ...data, number: (last?.n ?? 0) + 1, id: newId('decision'), createdAt: nowIso() })
        .returning()
        .get();
    },

    get(id: string): Decision | undefined {
      return db.select().from(decisions).where(eq(decisions.id, id)).get();
    },

    list(opts: { status?: DecisionStatus; taskId?: string; threadId?: string } = {}): Decision[] {
      return db
        .select()
        .from(decisions)
        .where(
          and(
            opts.status ? eq(decisions.status, opts.status) : undefined,
            opts.taskId ? eq(decisions.taskId, opts.taskId) : undefined,
            opts.threadId ? eq(decisions.threadId, opts.threadId) : undefined,
          ),
        )
        .orderBy(desc(decisions.createdAt))
        .all();
    },

    update(id: string, input: DecisionUpdateInput): Decision | undefined {
      const patch = definedOnly(decisionUpdateSchema.parse(input));
      if (isEmpty(patch)) return this.get(id);
      return db.update(decisions).set(patch).where(eq(decisions.id, id)).returning().get();
    },

    delete(id: string): boolean {
      return db.delete(decisions).where(eq(decisions.id, id)).run().changes > 0;
    },
  };
}
export type DecisionsRepo = ReturnType<typeof makeDecisionsRepo>;

export function makeLessonsRepo(db: Db) {
  return {
    create(input: LessonCreateInput): Lesson {
      const data = lessonCreateSchema.parse(input);
      return db
        .insert(lessons)
        .values({ ...data, id: newId('lesson'), createdAt: nowIso() })
        .returning()
        .get();
    },

    get(id: string): Lesson | undefined {
      return db.select().from(lessons).where(eq(lessons.id, id)).get();
    },

    list(opts: { topic?: string } = {}): Lesson[] {
      return db
        .select()
        .from(lessons)
        .where(opts.topic ? eq(lessons.topic, opts.topic) : undefined)
        .orderBy(desc(lessons.createdAt))
        .all();
    },

    /** Lessons whose spaced-repetition review is due at or before `at`, soonest first. */
    listDue(at: string = nowIso()): Lesson[] {
      return db
        .select()
        .from(lessons)
        .where(and(isNotNull(lessons.nextReviewAt), lte(lessons.nextReviewAt, at)))
        .orderBy(asc(lessons.nextReviewAt))
        .all();
    },

    update(id: string, input: LessonUpdateInput): Lesson | undefined {
      const patch = definedOnly(lessonUpdateSchema.parse(input));
      if (isEmpty(patch)) return this.get(id);
      return db.update(lessons).set(patch).where(eq(lessons.id, id)).returning().get();
    },

    /** Increments reviewed_count and sets the next review time. */
    markReviewed(id: string, nextReviewAt: string | null): Lesson | undefined {
      return db
        .update(lessons)
        .set({ reviewedCount: sql`${lessons.reviewedCount} + 1`, nextReviewAt })
        .where(eq(lessons.id, id))
        .returning()
        .get();
    },

    delete(id: string): boolean {
      return db.delete(lessons).where(eq(lessons.id, id)).run().changes > 0;
    },
  };
}
export type LessonsRepo = ReturnType<typeof makeLessonsRepo>;
