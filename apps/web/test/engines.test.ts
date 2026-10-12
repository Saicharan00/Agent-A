import type { EngineAuthStatus } from '@agenta/shared';
import { describe, expect, it } from 'vitest';
import { dockerPill, enginePillLabel, engineView } from '@/lib/engines';

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
