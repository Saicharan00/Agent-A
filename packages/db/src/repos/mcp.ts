// External MCP servers behind the gateway (F35) and which bots may use them.
import {
  type BotMcpAccessInput,
  type McpServerCreateInput,
  type McpServerUpdateInput,
  type McpToolInfo,
  botMcpAccessSchema,
  mcpServerCreateSchema,
  mcpServerUpdateSchema,
  newId,
  nowIso,
} from '@agenta/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { type BotMcpAccess, type McpServer, botMcpAccess, mcpServers } from '../schema';
import { definedOnly, isEmpty } from './util';

export function makeMcpServersRepo(db: Db) {
  return {
    create(input: McpServerCreateInput): McpServer {
      const data = mcpServerCreateSchema.parse(input);
      return db
        .insert(mcpServers)
        .values({ ...data, id: newId('mcpServer'), createdAt: nowIso() })
        .returning()
        .get();
    },

    get(id: string): McpServer | undefined {
      return db.select().from(mcpServers).where(eq(mcpServers.id, id)).get();
    },

    getBySlug(slug: string): McpServer | undefined {
      return db.select().from(mcpServers).where(eq(mcpServers.slug, slug)).get();
    },

    list(): McpServer[] {
      return db.select().from(mcpServers).orderBy(asc(mcpServers.createdAt)).all();
    },

    update(id: string, input: McpServerUpdateInput): McpServer | undefined {
      const patch = definedOnly(mcpServerUpdateSchema.parse(input));
      if (isEmpty(patch)) return this.get(id);
      return db.update(mcpServers).set(patch).where(eq(mcpServers.id, id)).returning().get();
    },

    /** Records a connection check: the tools it listed (on success) and the error (null when it worked). */
    recordCheck(id: string, result: { tools?: McpToolInfo[]; error: string | null }): McpServer | undefined {
      return db
        .update(mcpServers)
        .set({
          lastCheckAt: nowIso(),
          lastError: result.error,
          ...(result.tools ? { toolsCache: result.tools } : {}),
        })
        .where(eq(mcpServers.id, id))
        .returning()
        .get();
    },

    delete(id: string): boolean {
      return db.delete(mcpServers).where(eq(mcpServers.id, id)).run().changes > 0;
    },

    /** The bot's grants, one per server. */
    accessForBot(botId: string): BotMcpAccess[] {
      return db.select().from(botMcpAccess).where(eq(botMcpAccess.botId, botId)).all();
    },

    getAccess(botId: string, serverId: string): BotMcpAccess | undefined {
      return db
        .select()
        .from(botMcpAccess)
        .where(and(eq(botMcpAccess.botId, botId), eq(botMcpAccess.serverId, serverId)))
        .get();
    },

    botIds(serverId: string): string[] {
      return db
        .select({ botId: botMcpAccess.botId })
        .from(botMcpAccess)
        .where(eq(botMcpAccess.serverId, serverId))
        .all()
        .map((r) => r.botId);
    },

    /** Replaces the bot's grants in one transaction. */
    setAccess(botId: string, access: BotMcpAccessInput[]): BotMcpAccess[] {
      const rows = access.map((a) => botMcpAccessSchema.parse(a));
      db.transaction((tx) => {
        tx.delete(botMcpAccess).where(eq(botMcpAccess.botId, botId)).run();
        for (const a of rows)
          tx.insert(botMcpAccess)
            .values({ botId, serverId: a.serverId, toolAllowlist: a.tools, toolPolicies: a.toolPolicies })
            .onConflictDoNothing()
            .run();
      });
      return this.accessForBot(botId);
    },
  };
}
export type McpServersRepo = ReturnType<typeof makeMcpServersRepo>;
