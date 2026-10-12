import { describe, expect, it } from 'vitest';
import {
  ID_PREFIXES,
  botCreateSchema,
  hasIdPrefix,
  msBetween,
  newId,
  nowIso,
  taskCreateSchema,
  toIso,
} from '../src/index';

describe('ids', () => {
  it('prefixes every kind and is unique', () => {
    for (const kind of Object.keys(ID_PREFIXES) as (keyof typeof ID_PREFIXES)[]) {
      const id = newId(kind);
      expect(id).toMatch(new RegExp(`^${ID_PREFIXES[kind]}_[0-9A-Za-z]{16}$`));
      expect(hasIdPrefix(id, kind)).toBe(true);
    }
    expect(new Set(Array.from({ length: 1000 }, () => newId('run'))).size).toBe(1000);
    expect(hasIdPrefix('thr_x', 'bot')).toBe(false);
  });
});

describe('time', () => {
  it('produces UTC ISO strings', () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(toIso(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(() => toIso('nope')).toThrow(RangeError);
    expect(msBetween('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.500Z')).toBe(1500);
  });
});

describe('dto schemas', () => {
  it('applies defaults on create', () => {
    const bot = botCreateSchema.parse({ name: ' Echo ', engine: 'mock' });
    expect(bot).toMatchObject({ name: 'Echo', avatarShape: 'circle', settings: { cpus: 2 } });
    expect(taskCreateSchema.parse({ title: 't' })).toMatchObject({ status: 'todo', priority: 'p2' });
  });

  it('rejects bad slugs and dates', () => {
    expect(() => botCreateSchema.parse({ name: 'x', engine: 'mock', slug: 'Bad Slug' })).toThrow();
    expect(() => taskCreateSchema.parse({ title: 't', dueAt: 'tomorrow' })).toThrow();
  });
});
