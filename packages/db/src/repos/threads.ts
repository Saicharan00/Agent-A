import {
  type ThreadCreateInput,
  type ThreadKind,
  type ThreadUpdateInput,
  newId,
  nowIso,
  threadCreateSchema,
  threadUpdateSchema,
} from '@agenta/shared';
import { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { type Bot, type Thread, bots, messages, threadMembers, threads } from '../schema';
import { definedOnly } from './util';

export function makeThreadsRepo(db: Db) {
  return {
    /** Creates the thread and its initial members in one transaction. */
    create(input: ThreadCreateInput): Thread {
      const { memberBotIds, ...data } = threadCreateSchema.parse(input);
      const ts = nowIso();
      return db.transaction((tx) => {
        const thread = tx
          .insert(threads)
          .values({ ...data, id: newId('thread'), createdAt: ts, updatedAt: ts })
          .returning()
          .get();
        const unique = [...new Set(memberBotIds)];
        if (unique.length > 0) {
          tx.insert(threadMembers)
            .values(unique.map((botId) => ({ threadId: thread.id, botId, joinedAt: ts })))
            .run();
        }
        return thread;
      });
    },

    get(id: string): Thread | undefined {
      return db.select().from(threads).where(eq(threads.id, id)).get();
    },

    /** Most recently active first. */
    list(opts: { kind?: ThreadKind; botId?: string; includeArchived?: boolean } = {}): Thread[] {
      const conds = [
        opts.kind ? eq(threads.kind, opts.kind) : undefined,
        opts.includeArchived ? undefined : isNull(threads.archivedAt),
        opts.botId
          ? inArray(
              threads.id,
              db
                .select({ id: threadMembers.threadId })
                .from(threadMembers)
                .where(eq(threadMembers.botId, opts.botId)),
            )
          : undefined,
      ];
      return db
        .select()
        .from(threads)
        .where(and(...conds))
        .orderBy(desc(threads.updatedAt))
        .all();
    },

    /** The (non-archived) DM thread between the owner and this bot. */
    findDm(botId: string): Thread | undefined {
      return db
        .select({ thread: threads })
        .from(threads)
        .innerJoin(threadMembers, eq(threadMembers.threadId, threads.id))
        .where(and(eq(threads.kind, 'dm'), eq(threadMembers.botId, botId), isNull(threads.archivedAt)))
        .get()?.thread;
    },

    update(id: string, input: ThreadUpdateInput): Thread | undefined {
      const patch = definedOnly(threadUpdateSchema.parse(input));
      return db
        .update(threads)
        .set({ ...patch, updatedAt: nowIso() })
        .where(eq(threads.id, id))
        .returning()
        .get();
    },

    /** Group pause (F18): a timestamp pauses, null resumes. */
    setPaused(id: string, at: string | null): Thread | undefined {
      return db.update(threads).set({ pausedAt: at }).where(eq(threads.id, id)).returning().get();
    },

    /** Bumps updated_at (e.g. when a message is posted) so lists sort by activity. */
    touch(id: string, at: string = nowIso()): void {
      db.update(threads).set({ updatedAt: at }).where(eq(threads.id, id)).run();
    },

    /** Records that the owner has seen the thread up to `at` (never moves backwards). */
    markRead(id: string, at: string = nowIso()): Thread | undefined {
      return db
        .update(threads)
        .set({ lastReadAt: at })
        .where(and(eq(threads.id, id), or(isNull(threads.lastReadAt), sql`${threads.lastReadAt} < ${at}`)))
        .returning()
        .get();
    },

    /**
     * Messages the owner hasn't seen, per non-archived thread: everything not written by the owner after the
     * thread's last read, filtered by the thread's notification level (mentions: system messages and messages that
     * mention @owner; none: nothing). Threads without unread messages are left out.
     */
    unreadCounts(): Record<string, number> {
      const rows = db
        .select({ threadId: messages.threadId, n: sql<number>`count(*)` })
        .from(messages)
        .innerJoin(threads, eq(threads.id, messages.threadId))
        .where(
          and(
            isNull(threads.archivedAt),
            ne(messages.authorType, 'user'),
            or(isNull(threads.lastReadAt), gt(messages.createdAt, threads.lastReadAt)),
            ne(threads.notifications, 'none'),
            or(
              ne(threads.notifications, 'mentions'),
              eq(messages.authorType, 'system'),
              sql`lower(${messages.contentMd}) like '%@owner%'`,
            ),
          ),
        )
        .groupBy(messages.threadId)
        .all();
      return Object.fromEntries(rows.map((r) => [r.threadId, Number(r.n)]));
    },

    archive(id: string): Thread | undefined {
      const ts = nowIso();
      return db
        .update(threads)
        .set({ archivedAt: ts, updatedAt: ts })
        .where(eq(threads.id, id))
        .returning()
        .get();
    },

    delete(id: string): boolean {
      return db.delete(threads).where(eq(threads.id, id)).run().changes > 0;
    },

    /** Idempotent. Returns true if the bot was newly added. */
    addMember(threadId: string, botId: string): boolean {
      const res = db
        .insert(threadMembers)
        .values({ threadId, botId, joinedAt: nowIso() })
        .onConflictDoNothing()
        .run();
      return res.changes > 0;
    },

    removeMember(threadId: string, botId: string): boolean {
      return (
        db
          .delete(threadMembers)
          .where(and(eq(threadMembers.threadId, threadId), eq(threadMembers.botId, botId)))
          .run().changes > 0
      );
    },

    /** Member bots in join order. */
    listMembers(threadId: string): Bot[] {
      return db
        .select({ bot: bots })
        .from(threadMembers)
        .innerJoin(bots, eq(bots.id, threadMembers.botId))
        .where(eq(threadMembers.threadId, threadId))
        .orderBy(asc(threadMembers.joinedAt), asc(bots.name))
        .all()
        .map((r) => r.bot);
    },

    isMember(threadId: string, botId: string): boolean {
      return (
        db
          .select({ botId: threadMembers.botId })
          .from(threadMembers)
          .where(and(eq(threadMembers.threadId, threadId), eq(threadMembers.botId, botId)))
          .get() !== undefined
      );
    },
  };
}
export type ThreadsRepo = ReturnType<typeof makeThreadsRepo>;
