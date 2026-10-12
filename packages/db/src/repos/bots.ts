import {
  type BotCreateInput,
  type BotRuntimeUpdate,
  type BotUpdateInput,
  botCreateSchema,
  botRuntimeUpdateSchema,
  botUpdateSchema,
  newId,
  nowIso,
} from '@agenta/shared';
import { and, asc, eq, isNull, like, or } from 'drizzle-orm';
import type { Db } from '../client';
import { type Bot, bots } from '../schema';
import { definedOnly, isEmpty } from './util';

export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // drop combining accents: "Ü" → "U"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || 'bot';
}

export function makeBotsRepo(db: Db) {
  function getBySlug(slug: string): Bot | undefined {
    return db.select().from(bots).where(eq(bots.slug, slug)).get();
  }

  /** `base`, or `base-2`, `base-3`… — whichever is free. */
  function uniqueSlug(base: string): string {
    const taken = new Set(
      db
        .select({ slug: bots.slug })
        .from(bots)
        .where(or(eq(bots.slug, base), like(bots.slug, `${base}-%`)))
        .all()
        .map((r) => r.slug),
    );
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }

  return {
    create(input: BotCreateInput): Bot {
      const data = botCreateSchema.parse(input);
      const ts = nowIso();
      return db
        .insert(bots)
        .values({
          ...data,
          id: newId('bot'),
          slug: uniqueSlug(data.slug ?? slugify(data.name)),
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .get();
    },

    get(id: string): Bot | undefined {
      return db.select().from(bots).where(eq(bots.id, id)).get();
    },

    getBySlug,

    list(opts: { includeArchived?: boolean } = {}): Bot[] {
      return db
        .select()
        .from(bots)
        .where(opts.includeArchived ? undefined : isNull(bots.archivedAt))
        .orderBy(asc(bots.createdAt), asc(bots.name))
        .all();
    },

    /** The lead bot (Agent A), if one exists and is not archived. */
    getLead(): Bot | undefined {
      return db
        .select()
        .from(bots)
        .where(and(eq(bots.isLead, true), isNull(bots.archivedAt)))
        .get();
    },

    update(id: string, input: BotUpdateInput): Bot | undefined {
      const patch = definedOnly(botUpdateSchema.parse(input));
      if (patch.slug !== undefined) {
        const owner = getBySlug(patch.slug);
        if (owner && owner.id !== id) throw new Error(`Slug "${patch.slug}" is already taken`);
      }
      return db
        .update(bots)
        .set({ ...patch, updatedAt: nowIso() })
        .where(eq(bots.id, id))
        .returning()
        .get();
    },

    /** Container-manager fields (status, container id, ports, MCP token hash). */
    updateRuntime(id: string, input: BotRuntimeUpdate): Bot | undefined {
      const patch = definedOnly(botRuntimeUpdateSchema.parse(input));
      if (isEmpty(patch)) return this.get(id);
      return db
        .update(bots)
        .set({ ...patch, updatedAt: nowIso() })
        .where(eq(bots.id, id))
        .returning()
        .get();
    },

    archive(id: string): Bot | undefined {
      const ts = nowIso();
      return db.update(bots).set({ archivedAt: ts, updatedAt: ts }).where(eq(bots.id, id)).returning().get();
    },

    unarchive(id: string): Bot | undefined {
      return db
        .update(bots)
        .set({ archivedAt: null, updatedAt: nowIso() })
        .where(eq(bots.id, id))
        .returning()
        .get();
    },

    /** Hard delete; cascades to memberships, sessions, runs, memories, approvals, schedules. */
    delete(id: string): boolean {
      return db.delete(bots).where(eq(bots.id, id)).run().changes > 0;
    },
  };
}
export type BotsRepo = ReturnType<typeof makeBotsRepo>;
