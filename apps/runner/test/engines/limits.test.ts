import { describe, expect, it } from 'vitest';
import { nextWallTime, parseResetTime, toIso } from '../../src/engines/limits';

const NOW = new Date('2026-10-13T10:00:00.000Z');

describe('parseResetTime', () => {
  it('epoch seconds after a pipe (older Claude Code format)', () => {
    expect(parseResetTime('Claude AI usage limit reached|1791900000', NOW)).toBe(
      new Date(1791900000 * 1000).toISOString(),
    );
  });

  it('ISO timestamps', () => {
    expect(parseResetTime('Rate limit; resets at 2026-10-13T12:30:00Z', NOW)).toBe(
      '2026-10-13T12:30:00.000Z',
    );
  });

  it('wall-clock times, default UTC, rolling over to tomorrow when already past', () => {
    expect(parseResetTime("You've hit your limit · resets 3pm", NOW)).toBe('2026-10-13T15:00:00.000Z');
    expect(parseResetTime('5-hour limit reached ∙ resets 9:30am', NOW)).toBe('2026-10-14T09:30:00.000Z');
    expect(parseResetTime('limit reached, resets at 12am (UTC)', NOW)).toBe('2026-10-14T00:00:00.000Z');
    expect(parseResetTime('resets 17:45', NOW)).toBe('2026-10-13T17:45:00.000Z');
  });

  it('wall-clock times in an IANA zone (DST-aware)', () => {
    // Berlin is UTC+2 on 2026-10-13 (CEST)
    expect(parseResetTime("You've hit your limit · resets 3pm (Europe/Berlin)", NOW)).toBe(
      '2026-10-13T13:00:00.000Z',
    );
    // Kolkata is UTC+5:30 → 10:00Z is 15:30 local; 4pm local = 10:30Z
    expect(parseResetTime('resets 4pm (Asia/Kolkata)', NOW)).toBe('2026-10-13T10:30:00.000Z');
    // unknown zone → UTC
    expect(parseResetTime('resets 3pm (Mars/Base)', NOW)).toBe('2026-10-13T15:00:00.000Z');
  });

  it('relative times', () => {
    expect(parseResetTime('Usage limit reached. Try again in 2 hours 15 minutes.', NOW)).toBe(
      '2026-10-13T12:15:00.000Z',
    );
    expect(parseResetTime('limit reached in your plan; resets in 45m', NOW)).toBe('2026-10-13T10:45:00.000Z');
  });

  it('Codex wording: time today, or a full date', () => {
    const base =
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at";
    expect(parseResetTime(`${base} 3:05 PM.`, NOW)).toBe('2026-10-13T15:05:00.000Z');
    expect(parseResetTime(`${base} Oct 14th, 2026 9:05 AM.`, NOW)).toBe('2026-10-14T09:05:00.000Z');
    expect(parseResetTime(`${base} later.`, NOW)).toBeUndefined();
  });

  it('nothing usable → undefined', () => {
    expect(parseResetTime("You've hit your limit", NOW)).toBeUndefined();
    expect(parseResetTime('resets 3', NOW)).toBeUndefined();
    expect(parseResetTime('resets 25:00', NOW)).toBeUndefined();
  });
});

describe('helpers', () => {
  it('toIso accepts seconds, milliseconds and ISO strings', () => {
    expect(toIso(1791900000)).toBe(toIso(1791900000000));
    expect(toIso('1791900000')).toBe(toIso(1791900000));
    expect(toIso('2026-10-13T10:00:00Z')).toBe('2026-10-13T10:00:00.000Z');
    expect(toIso('nope')).toBeUndefined();
    expect(toIso(-1)).toBeUndefined();
  });

  it('nextWallTime crosses a DST change correctly', () => {
    // Europe/Berlin leaves DST on 2026-10-25 03:00 local. From 23:00Z on the 24th (01:00 CEST),
    // the next 09:00 local is in CET (UTC+1) → 08:00Z.
    expect(nextWallTime(9, 0, 'Europe/Berlin', new Date('2026-10-24T23:00:00Z')).toISOString()).toBe(
      '2026-10-25T08:00:00.000Z',
    );
  });
});
