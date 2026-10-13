import { type MessageCreateInput, messageCreateSchema, newId, nowIso } from '@agenta/shared';
import { and, asc, desc, eq, gt, lt, or } from 'drizzle-orm';
import type { Db } from '../client';
import { type Message, messages, threads } from '../schema';
import { pageSize, rowidOf } from './util';

// Messages are ordered by (created_at, rowid): IDs are random, and two messages can share a millisecond.
const rowid = rowidOf(messages);

export function makeMessagesRepo(db: Db) {
  function cursorOf(id: string) {
    return db
      .select({ createdAt: messages.createdAt, rowid })
      .from(messages)
      .where(eq(messages.id, id))
      .get();
  }

  return {
    /** Inserts the message and bumps the thread's updated_at in one transaction. */
    create(input: MessageCreateInput): Message {
      const data = messageCreateSchema.parse(input);
      const ts = nowIso();
      return db.transaction((tx) => {
        const msg = tx
          .insert(messages)
          .values({ ...data, id: newId('message'), createdAt: ts })
          .returning()
          .get();
        tx.update(threads).set({ updatedAt: ts }).where(eq(threads.id, data.threadId)).run();
        return msg;
      });
    },

    get(id: string): Message | undefined {
      return db.select().from(messages).where(eq(messages.id, id)).get();
    },

    /**
     * A page of a thread's history in chronological order: the newest `limit` messages,
     * or the `limit` messages just before `before` (a message id) for scroll-back.
     */
    listByThread(threadId: string, opts: { before?: string; limit?: number } = {}): Message[] {
      const cursor = opts.before ? cursorOf(opts.before) : undefined;
      if (opts.before && !cursor) return [];
      const rows = db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.threadId, threadId),
            cursor
              ? or(
                  lt(messages.createdAt, cursor.createdAt),
                  and(eq(messages.createdAt, cursor.createdAt), lt(rowid, cursor.rowid)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(messages.createdAt), desc(rowid))
        .limit(pageSize(opts.limit))
        .all();
      return rows.reverse();
    },

    /** Messages posted after `afterId` (all of them when afterId is null), oldest first. */
    listSince(threadId: string, afterId: string | null, limit = 200): Message[] {
      const cursor = afterId ? cursorOf(afterId) : undefined;
      return db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.threadId, threadId),
            cursor
              ? or(
                  gt(messages.createdAt, cursor.createdAt),
                  and(eq(messages.createdAt, cursor.createdAt), gt(rowid, cursor.rowid)),
                )
              : undefined,
          ),
        )
        .orderBy(asc(messages.createdAt), asc(rowid))
        .limit(pageSize(limit, 200, 1000))
        .all();
    },

    latest(threadId: string): Message | undefined {
      return db
        .select()
        .from(messages)
        .where(eq(messages.threadId, threadId))
        .orderBy(desc(messages.createdAt), desc(rowid))
        .get();
    },

    /** Replaces a message's text (a bot reply growing while its run streams). */
    updateContent(id: string, contentMd: string): Message | undefined {
      return db.update(messages).set({ contentMd }).where(eq(messages.id, id)).returning().get();
    },

    /** The bot reply created by a run, if any. */
    getByRun(runId: string): Message | undefined {
      return db
        .select()
        .from(messages)
        .where(and(eq(messages.runId, runId), eq(messages.authorType, 'bot')))
        .orderBy(asc(messages.createdAt), asc(rowid))
        .get();
    },

    /** The bots a message @mentions (group routing, F18). */
    setMentions(id: string, mentions: string[]): Message | undefined {
      return db.update(messages).set({ mentions }).where(eq(messages.id, id)).returning().get();
    },

    setRunId(id: string, runId: string): Message | undefined {
      return db.update(messages).set({ runId }).where(eq(messages.id, id)).returning().get();
    },

    delete(id: string): boolean {
      return db.delete(messages).where(eq(messages.id, id)).run().changes > 0;
    },
  };
}
export type MessagesRepo = ReturnType<typeof makeMessagesRepo>;
