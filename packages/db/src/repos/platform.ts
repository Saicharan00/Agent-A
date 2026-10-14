// Connectors, confidentiality guard terms and key/value settings.
import {
  type ConnectorCreateInput,
  type ConnectorUpdateInput,
  type GuardTermCreateInput,
  connectorCreateSchema,
  connectorUpdateSchema,
  guardTermCreateSchema,
  newId,
  nowIso,
  settingKeySchema,
} from '@agenta/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { type Connector, type GuardTerm, botConnectors, connectors, guardTerms, settings } from '../schema';
import { definedOnly, isEmpty } from './util';

export function makeConnectorsRepo(db: Db) {
  return {
    create(input: ConnectorCreateInput): Connector {
      const data = connectorCreateSchema.parse(input);
      return db
        .insert(connectors)
        .values({ ...data, id: newId('connector'), createdAt: nowIso() })
        .returning()
        .get();
    },

    get(id: string): Connector | undefined {
      return db.select().from(connectors).where(eq(connectors.id, id)).get();
    },

    list(): Connector[] {
      return db.select().from(connectors).orderBy(asc(connectors.createdAt)).all();
    },

    update(id: string, input: ConnectorUpdateInput): Connector | undefined {
      const patch = definedOnly(connectorUpdateSchema.parse(input));
      if (isEmpty(patch)) return this.get(id);
      return db.update(connectors).set(patch).where(eq(connectors.id, id)).returning().get();
    },

    delete(id: string): boolean {
      return db.delete(connectors).where(eq(connectors.id, id)).run().changes > 0;
    },

    /** Idempotent. */
    attach(botId: string, connectorId: string): void {
      db.insert(botConnectors).values({ botId, connectorId }).onConflictDoNothing().run();
    },

    detach(botId: string, connectorId: string): boolean {
      return (
        db
          .delete(botConnectors)
          .where(and(eq(botConnectors.botId, botId), eq(botConnectors.connectorId, connectorId)))
          .run().changes > 0
      );
    },

    listForBot(botId: string): Connector[] {
      return db
        .select({ connector: connectors })
        .from(botConnectors)
        .innerJoin(connectors, eq(connectors.id, botConnectors.connectorId))
        .where(eq(botConnectors.botId, botId))
        .orderBy(asc(connectors.createdAt))
        .all()
        .map((r) => r.connector);
    },

    botIds(connectorId: string): string[] {
      return db
        .select({ botId: botConnectors.botId })
        .from(botConnectors)
        .where(eq(botConnectors.connectorId, connectorId))
        .all()
        .map((r) => r.botId);
    },

    /** Replaces the connector's bots in one transaction. */
    setBots(connectorId: string, botIds: string[]): void {
      db.transaction((tx) => {
        tx.delete(botConnectors).where(eq(botConnectors.connectorId, connectorId)).run();
        for (const botId of new Set(botIds)) tx.insert(botConnectors).values({ botId, connectorId }).run();
      });
    },
  };
}
export type ConnectorsRepo = ReturnType<typeof makeConnectorsRepo>;

export function makeGuardTermsRepo(db: Db) {
  return {
    create(input: GuardTermCreateInput): GuardTerm {
      const data = guardTermCreateSchema.parse(input);
      return db
        .insert(guardTerms)
        .values({ ...data, id: newId('guardTerm'), createdAt: nowIso() })
        .returning()
        .get();
    },

    get(id: string): GuardTerm | undefined {
      return db.select().from(guardTerms).where(eq(guardTerms.id, id)).get();
    },

    list(): GuardTerm[] {
      return db.select().from(guardTerms).orderBy(asc(guardTerms.createdAt)).all();
    },

    delete(id: string): boolean {
      return db.delete(guardTerms).where(eq(guardTerms.id, id)).run().changes > 0;
    },
  };
}
export type GuardTermsRepo = ReturnType<typeof makeGuardTermsRepo>;

/** JSON key/value settings. Values must be JSON-serialisable; never store secrets here. */
export function makeSettingsRepo(db: Db) {
  return {
    get<T = unknown>(key: string): T | undefined {
      return db.select().from(settings).where(eq(settings.key, key)).get()?.value as T | undefined;
    },

    set(key: string, value: unknown): void {
      settingKeySchema.parse(key);
      if (value === undefined) throw new TypeError('Setting value cannot be undefined; use delete()');
      db.insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
        .run();
    },

    delete(key: string): boolean {
      return db.delete(settings).where(eq(settings.key, key)).run().changes > 0;
    },

    all(): Record<string, unknown> {
      return Object.fromEntries(
        db
          .select()
          .from(settings)
          .orderBy(asc(settings.key))
          .all()
          .map((r) => [r.key, r.value]),
      );
    },
  };
}
export type SettingsRepo = ReturnType<typeof makeSettingsRepo>;
