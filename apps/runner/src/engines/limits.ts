// Subscription usage-limit messages → reset time. Engines word these differently across versions, e.g.
//   "Claude AI usage limit reached|1760461200"            (epoch seconds after a pipe)
//   "You've hit your limit · resets 3pm (Europe/Berlin)"   (wall-clock time, optional IANA zone)
//   "… try again in 2 hours 15 minutes" / "resets in 45m"  (relative)
//   "… or try again at 3:05 PM." / "… try again at Oct 14th, 2026 3:05 PM."  (Codex; the container's zone is UTC)
// Unparseable → undefined; the run queue then falls back to its default back-off (F10).

/** Converts epoch seconds/milliseconds or an ISO string to an ISO string, if plausible. */
export function toIso(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    if (/^\d{9,13}$/.test(value.trim())) return toIso(Number(value));
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return undefined;
}

/** Milliseconds to add to UTC to get the wall clock in `tz` at instant `t`. Throws on an unknown zone. */
function tzOffsetMs(t: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return local - Math.floor(t / 1000) * 1000;
}

/** The next instant after `now` at which the wall clock in `tz` reads hour:minute. */
export function nextWallTime(hour: number, minute: number, tz: string, now: Date): Date {
  const off = tzOffsetMs(now.getTime(), tz);
  const local = new Date(now.getTime() + off);
  let candidate =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute) - off;
  if (candidate <= now.getTime()) candidate += 24 * 3600 * 1000;
  // Re-apply the offset valid at the candidate (DST change in between).
  candidate += off - tzOffsetMs(candidate, tz);
  return new Date(candidate);
}

const RELATIVE =
  /\bin\s+(?:(\d+)\s*(?:h|hr|hrs|hours?)\b)?[\s,]*(?:and\s+)?(?:(\d+)\s*(?:m|min|mins|minutes?)\b)?/gi;
const WALL = /\b(?:resets?|try again)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i;

/** Finds a reset time in an engine's limit message. */
export function parseResetTime(text: string, now: Date = new Date()): string | undefined {
  const epoch = /\|\s*(\d{10,13})\b/.exec(text);
  if (epoch) return toIso(Number(epoch[1]));

  const iso = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/.exec(text);
  if (iso) return toIso(iso[0]);

  const dated =
    /\b(?:resets?|try again)\s+(?:at|on)?\s*([A-Z][a-z]{2,8}\.? \d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? (\d{1,2}:\d{2}\s*[AP]M)/i.exec(
      text,
    );
  if (dated) {
    const t = Date.parse(`${dated[1]}, ${dated[2]} ${dated[3]} UTC`);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }

  if (/reset|try again|available/i.test(text)) {
    for (const rel of text.matchAll(RELATIVE)) {
      if (!rel[1] && !rel[2]) continue;
      const ms = (Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0)) * 60_000;
      return new Date(now.getTime() + ms).toISOString();
    }
  }

  const wall = WALL.exec(text);
  if (wall && (wall[2] || wall[3])) {
    let hour = Number(wall[1]);
    const minute = Number(wall[2] ?? 0);
    const ampm = wall[3]?.toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return undefined;
    try {
      return nextWallTime(hour, minute, wall[4]?.trim() || 'UTC', now).toISOString();
    } catch {
      return nextWallTime(hour, minute, 'UTC', now).toISOString();
    }
  }
  return undefined;
}
