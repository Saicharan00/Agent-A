import { type Engine, nowIso } from '@agenta/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { type BotThreadSession, botThreadSessions } from '../schema';

export type SessionUpsert = {
  botId: string;
  threadId: string;
  engine: Engine;
  engineSessionId?: string | null;
  lastSeenMessageId?: string | null;
};

/** One engine session per (bot, thread) — PLAN §2 decision 3. */
export function makeSessionsRepo(db: Db) {
  const key = (botId: string, threadId: string) =>
    and(eq(botThreadSessions.botId, botId), eq(botThreadSessions.threadId, threadId));

  return {
    get(botId: string, threadId: string): BotThreadSession | undefined {
      return db.select().from(botThreadSessions).where(key(botId, threadId)).get();
    },

    /** Insert or update; omitted optional fields keep their stored value. */
    upsert(input: SessionUpsert): BotThreadSession {
      const ts = nowIso();
      const patch = {
        engine: input.engine,
        updatedAt: ts,
        ...(input.engineSessionId !== undefined && { engineSessionId: input.engineSessionId }),
        ...(input.lastSeenMessageId !== undefined && { lastSeenMessageId: input.lastSeenMessageId }),
      };
      return db
        .insert(botThreadSessions)
        .values({ botId: input.botId, threadId: input.threadId, ...patch })
        .onConflictDoUpdate({ target: [botThreadSessions.botId, botThreadSessions.threadId], set: patch })
        .returning()
        .get();
    },

    listByBot(botId: string): BotThreadSession[] {
      return db.select().from(botThreadSessions).where(eq(botThreadSessions.botId, botId)).all();
    },

    /** Forget a session (e.g. engine switched or the user starts fresh). */
    delete(botId: string, threadId: string): boolean {
      return db.delete(botThreadSessions).where(key(botId, threadId)).run().changes > 0;
    },

    deleteByBot(botId: string): number {
      return db.delete(botThreadSessions).where(eq(botThreadSessions.botId, botId)).run().changes;
    },
  };
}
export type SessionsRepo = ReturnType<typeof makeSessionsRepo>;
