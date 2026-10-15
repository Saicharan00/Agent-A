import type { BotView } from '@agenta/shared';
import { describe, expect, it } from 'vitest';
import {
  botToForm,
  changedFields,
  defaultBotForm,
  formToRequest,
  relativeTime,
  slugPreview,
  sortBots,
} from '../lib/bots';

const bot = (over: Partial<BotView> = {}): BotView => ({
  id: 'bot_1',
  name: 'Code Reviewer',
  slug: 'code-reviewer',
  role: 'Reviews PRs',
  instructions: '# Hi',
  engine: 'claude',
  model: null,
  avatarColor: '#6366f1',
  avatarShape: 'circle',
  isLead: false,
  status: 'stopped',
  settings: { cpus: 2, memoryMb: 2048, idleTimeoutMin: 30, flags: { beta: true } },
  sidebarVisible: true,
  notifications: 'all',
  createdAt: '2026-10-13T10:00:00.000Z',
  updatedAt: '2026-10-13T10:00:00.000Z',
  archivedAt: null,
  dmThreadId: 'thr_1',
  lastActivityAt: null,
  ...over,
});

describe('bot form logic', () => {
  it('builds a valid create request from the defaults plus a name', () => {
    const res = formToRequest({ ...defaultBotForm(), name: '  Researcher  ' });
    expect(res).toEqual({
      ok: true,
      body: expect.objectContaining({
        name: 'Researcher',
        engine: 'claude',
        model: null,
        settings: { memoryMb: 2048, cpus: 2, idleTimeoutMin: 30, flags: {} },
      }),
    });
    expect(res.ok && 'slug' in res.body).toBe(false); // blank handle → derived by the runner
  });

  it('starts from the owner resource defaults when given (F31)', () => {
    const form = defaultBotForm({ cpus: 1.5, memoryMb: 1024, idleTimeoutMin: 0 });
    expect(form).toMatchObject({ cpus: '1.5', memoryMb: '1024', idleTimeoutMin: '0' });
  });

  it('reports field-level errors with friendly messages', () => {
    const res = formToRequest({
      ...defaultBotForm(),
      name: ' ',
      slug: 'Not OK',
      memoryMb: '12',
      cpus: '',
      idleTimeoutMin: '-1',
      runTimeoutMin: '0',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(Object.keys(res.errors).sort()).toEqual(
      ['cpus', 'idleTimeoutMin', 'memoryMb', 'name', 'runTimeoutMin', 'slug'].sort(),
    );
    expect(res.errors.memoryMb).toMatch(/256 and 65536/);
  });

  it('round-trips a bot through the form, keeps flags and diffs only changes', () => {
    const b = bot({
      settings: { cpus: 1.5, memoryMb: 1024, idleTimeoutMin: 0, runTimeoutMin: 45, flags: { x: 1 } },
    });
    const form = botToForm(b);
    expect(form).toMatchObject({ model: '', cpus: '1.5', runTimeoutMin: '45' });
    const res = formToRequest(form, b);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.settings).toEqual(b.settings);
    expect(changedFields(res.body, b)).toEqual({});

    const edited = formToRequest({ ...form, instructions: 'new', model: 'opus', runTimeoutMin: '' }, b);
    if (!edited.ok) throw new Error('invalid');
    expect(changedFields(edited.body, b)).toEqual({
      instructions: 'new',
      model: 'opus',
      settings: { cpus: 1.5, memoryMb: 1024, idleTimeoutMin: 0, flags: { x: 1 } },
    });
  });

  it('previews the handle like the runner does', () => {
    expect(slugPreview('Code Reviewer')).toBe('code-reviewer');
    expect(slugPreview('Über Bot!!')).toBe('uber-bot');
    expect(slugPreview('***')).toBe('bot');
  });

  it('sorts the lead first, then by activity, then newest', () => {
    const sorted = sortBots([
      bot({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
      bot({ id: 'active', lastActivityAt: '2026-10-13T09:00:00.000Z' }),
      bot({ id: 'lead', isLead: true }),
      bot({ id: 'new', createdAt: '2026-10-12T00:00:00.000Z' }),
    ]);
    expect(sorted.map((b) => b.id)).toEqual(['lead', 'active', 'new', 'old']);
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-10-13T12:00:00.000Z');
    expect(relativeTime(null, now)).toBe('No activity yet');
    expect(relativeTime('2026-10-13T11:59:40.000Z', now)).toBe('just now');
    expect(relativeTime('2026-10-13T11:55:00.000Z', now)).toBe('5 min ago');
    expect(relativeTime('2026-10-13T09:00:00.000Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-10-11T12:00:00.000Z', now)).toBe('2 d ago');
  });
});
