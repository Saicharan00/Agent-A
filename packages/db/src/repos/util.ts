import { type SQL, sql } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

/**
 * The table's implicit rowid: insertion order. IDs are random and timestamps have
 * millisecond resolution, so ordering by created_at alone is not stable — tie-break on this.
 */
export function rowidOf(table: SQLiteTable): SQL<number> {
  return sql<number>`${table}.rowid`;
}

/** Drops keys whose value is `undefined` so partial updates never null-out omitted columns. */
export function definedOnly<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function isEmpty(obj: object): boolean {
  return Object.keys(obj).length === 0;
}

/** Clamps list page sizes so callers can't ask for unbounded result sets. */
export function pageSize(limit: number | undefined, fallback = 50, max = 500): number {
  if (limit === undefined) return fallback;
  return Math.max(1, Math.min(max, Math.floor(limit)));
}
