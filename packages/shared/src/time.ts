/** Current time as a UTC ISO string — the only timestamp format stored in the DB. */
export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(date: Date | number | string): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid date: ${String(date)}`);
  return d.toISOString();
}

/** Milliseconds between two ISO timestamps (b - a). */
export function msBetween(a: string, b: string): number {
  return new Date(b).getTime() - new Date(a).getTime();
}
