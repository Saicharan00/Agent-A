import {
  type TaskCreateInput,
  type TaskEventCreateInput,
  type TaskStatus,
  type TaskUpdateInput,
  newId,
  nowIso,
  taskCreateSchema,
  taskEventCreateSchema,
  taskUpdateSchema,
} from '@agenta/shared';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../client';
import { type Task, type TaskEvent, taskEvents, tasks } from '../schema';
import { definedOnly, rowidOf } from './util';

export function makeTasksRepo(db: Db) {
  return {
    create(input: TaskCreateInput): Task {
      const data = taskCreateSchema.parse(input);
      const ts = nowIso();
      return db
        .insert(tasks)
        .values({ ...data, id: newId('task'), createdAt: ts, updatedAt: ts })
        .returning()
        .get();
    },

    get(id: string): Task | undefined {
      return db.select().from(tasks).where(eq(tasks.id, id)).get();
    },

    /** Most recently updated first. `parentTaskId: null` means top-level tasks only. */
    list(
      opts: { status?: TaskStatus | TaskStatus[]; assigneeBotId?: string; parentTaskId?: string | null } = {},
    ): Task[] {
      const statuses = opts.status === undefined ? undefined : [opts.status].flat();
      return db
        .select()
        .from(tasks)
        .where(
          and(
            statuses ? inArray(tasks.status, statuses) : undefined,
            opts.assigneeBotId ? eq(tasks.assigneeBotId, opts.assigneeBotId) : undefined,
            opts.parentTaskId === null
              ? isNull(tasks.parentTaskId)
              : opts.parentTaskId
                ? eq(tasks.parentTaskId, opts.parentTaskId)
                : undefined,
          ),
        )
        .orderBy(desc(tasks.updatedAt))
        .all();
    },

    update(id: string, input: TaskUpdateInput): Task | undefined {
      const patch = definedOnly(taskUpdateSchema.parse(input));
      return db
        .update(tasks)
        .set({ ...patch, updatedAt: nowIso() })
        .where(eq(tasks.id, id))
        .returning()
        .get();
    },

    delete(id: string): boolean {
      return db.delete(tasks).where(eq(tasks.id, id)).run().changes > 0;
    },

    addEvent(input: TaskEventCreateInput): TaskEvent {
      const data = taskEventCreateSchema.parse(input);
      return db
        .insert(taskEvents)
        .values({ ...data, id: newId('taskEvent'), createdAt: nowIso() })
        .returning()
        .get();
    },

    /** Oldest first (a task's timeline). */
    listEvents(taskId: string): TaskEvent[] {
      return db
        .select()
        .from(taskEvents)
        .where(eq(taskEvents.taskId, taskId))
        .orderBy(asc(taskEvents.createdAt), asc(rowidOf(taskEvents)))
        .all();
    },
  };
}
export type TasksRepo = ReturnType<typeof makeTasksRepo>;
