import {
  type GoalCreateInput,
  type GoalUpdateInput,
  goalCreateSchema,
  goalUpdateSchema,
  newId,
  nowIso,
} from '@agenta/shared';
import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { type Goal, goals, runs, tasks } from '../schema';
import { definedOnly } from './util';

export function makeGoalsRepo(db: Db) {
  return {
    create(input: GoalCreateInput): Goal {
      const data = goalCreateSchema.parse(input);
      const ts = nowIso();
      return db
        .insert(goals)
        .values({ ...data, id: newId('goal'), createdAt: ts, updatedAt: ts })
        .returning()
        .get();
    },

    get(id: string): Goal | undefined {
      return db.select().from(goals).where(eq(goals.id, id)).get();
    },

    getByThread(threadId: string): Goal | undefined {
      return db.select().from(goals).where(eq(goals.threadId, threadId)).get();
    },

    /** Newest first. */
    list(): Goal[] {
      return db.select().from(goals).orderBy(desc(goals.createdAt)).all();
    },

    update(id: string, input: GoalUpdateInput): Goal | undefined {
      const patch = definedOnly(goalUpdateSchema.parse(input));
      return db
        .update(goals)
        .set({ ...patch, updatedAt: nowIso() })
        .where(eq(goals.id, id))
        .returning()
        .get();
    },

    /** Runs started for the goal so far (every status counts against its budget). */
    countRuns(goalId: string): number {
      return (
        db
          .select({ n: sql<number>`count(*)` })
          .from(runs)
          .where(eq(runs.goalId, goalId))
          .get()?.n ?? 0
      );
    },

    /** The goal's tasks (sub-tasks included), oldest first. */
    listTasks(goalId: string) {
      return db.select().from(tasks).where(eq(tasks.goalId, goalId)).orderBy(tasks.createdAt).all();
    },

    /**
     * Deletes the goal and its tasks in one transaction (task events cascade). Runs, decisions and threads stay as
     * history: their links to the goal and its tasks are set to null by the foreign keys.
     */
    delete(id: string): boolean {
      return db.transaction((tx) => {
        tx.delete(tasks).where(eq(tasks.goalId, id)).run();
        return tx.delete(goals).where(eq(goals.id, id)).run().changes > 0;
      });
    },
  };
}
export type GoalsRepo = ReturnType<typeof makeGoalsRepo>;
