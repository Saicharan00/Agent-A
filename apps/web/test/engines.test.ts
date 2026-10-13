import type { EngineAuthStatus } from '@agenta/shared';
import { describe, expect, it } from 'vitest';
import {
  activeLimit,
  clockTime,
  dockerPill,
  enginePill,
  enginePillLabel,
  engineView,
  mockPill,
} from '@/lib/engines';

const status = (over: Partial<EngineAuthStatus>): EngineAuthStatus => ({
  engine: 'claude',
  state: 'configured',
  mode: 'token',
  detail: '',
  fix: [],
  perBotLogins: [],
  cli: { checked: false },
  checkedAt: '2026-10-12T00:00:00.000Z',
  ...over,
});

describe('engine display', () => {
  it('maps states to tones and labels', () => {
    expect(engineView(status({}))).toMatchObject({ tone: 'ok', state: 'configured', cli: null });
    expect(engineView(status({ state: 'missing', mode: 'none' }))).toMatchObject({
      tone: 'warn',
      mode: 'Not set up',
    });
    expect(engineView(status({ state: 'invalid' })).tone).toBe('error');
    expect(engineView(status({ mode: 'per-bot' })).tone).toBe('warn');
    expect(engineView(status({ cli: { checked: true, ok: false, output: 'Not logged in' } }))).toMatchObject({
      tone: 'error',
      cli: 'CLI reports a problem: Not logged in',
    });
    expect(engineView(status({ cli: { checked: true, ok: true } })).cli).toBe('CLI confirms the login');
  });

  it('labels top-bar pills', () => {
    expect(enginePillLabel(undefined, 'codex')).toBe('Codex: …');
    expect(enginePillLabel(status({}), 'claude')).toBe('Claude: ready');
    expect(enginePillLabel(status({ state: 'missing' }), 'claude')).toBe('Claude: not set up');
    expect(enginePillLabel(status({ mode: 'per-bot' }), 'claude')).toBe('Claude: per-bot');
    expect(dockerPill(undefined).tone).toBe('neutral');
    expect(dockerPill({ ok: false, error: 'x' })).toMatchObject({ tone: 'error', label: 'Docker: down' });
    expect(dockerPill({ ok: true, image: false }).tone).toBe('warn');
    expect(dockerPill({ ok: true, image: true, version: '29' })).toMatchObject({
      tone: 'ok',
      label: 'Docker: ok',
    });
  });
});

describe('live engine pills', () => {
  const now = Date.parse('2026-10-13T12:00:00.000Z');
  const later = '2026-10-13T14:05:00.000Z';

  it('a pause still in force wins over the auth state', () => {
    const p = enginePill('claude', status({}), later, now);
    expect(p.tone).toBe('warn');
    expect(p.label).toBe(`Claude: limited until ${clockTime(later)}`);
    expect(clockTime(later)).toMatch(/^\d{2}:\d{2}$/);
    expect(p.title).toContain('paused');
  });

  it('expired or absent pauses fall back to the auth pill', () => {
    expect(activeLimit('2026-10-13T11:59:59.000Z', now)).toBeNull();
    expect(
      enginePill('codex', status({ engine: 'codex', state: 'missing', mode: 'none' }), null, now),
    ).toMatchObject({
      tone: 'warn',
      label: 'Codex: not set up',
    });
    expect(enginePill('claude', undefined, undefined, now)).toMatchObject({
      tone: 'neutral',
      label: 'Claude: …',
    });
  });

  it('mock pill shows the override and its pauses', () => {
    expect(mockPill(null, now)).toMatchObject({ tone: 'neutral', label: 'Mock: on' });
    expect(mockPill(later, now)).toMatchObject({
      tone: 'warn',
      label: `Mock: limited until ${clockTime(later)}`,
    });
  });
});
