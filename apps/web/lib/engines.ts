import type { AuthEngine, EngineAuthStatus, HealthResponse } from '@agenta/shared';
import type { PillTone } from '@/components/status-pill';

export const ENGINE_LABELS: Record<AuthEngine, string> = { claude: 'Claude', codex: 'Codex' };

const MODE_LABELS: Record<EngineAuthStatus['mode'], string> = {
  token: 'Subscription token (.env.local)',
  'shared-file': 'Shared login (data/secrets)',
  'per-bot': 'Per-bot terminal login',
  none: 'Not set up',
};

export type EngineView = { tone: PillTone; state: string; mode: string; cli: string | null };

/** Display model for one engine's auth status (pill tone, labels). */
export function engineView(s: EngineAuthStatus): EngineView {
  const cli = !s.cli.checked
    ? null
    : s.cli.ok
      ? 'CLI confirms the login'
      : `CLI reports a problem${s.cli.output ? `: ${s.cli.output}` : ''}`;
  if (s.state === 'invalid') return { tone: 'error', state: 'invalid', mode: MODE_LABELS[s.mode], cli };
  if (s.state === 'missing') return { tone: 'warn', state: 'missing', mode: MODE_LABELS[s.mode], cli };
  const tone: PillTone = s.cli.checked && !s.cli.ok ? 'error' : s.mode === 'per-bot' ? 'warn' : 'ok';
  return { tone, state: 'configured', mode: MODE_LABELS[s.mode], cli };
}

/** Top-bar pill text, e.g. "Claude: ready" / "Codex: not set up". */
export function enginePillLabel(s: EngineAuthStatus | undefined, engine: AuthEngine): string {
  const name = ENGINE_LABELS[engine];
  if (!s) return `${name}: …`;
  if (s.state === 'missing') return `${name}: not set up`;
  if (s.state === 'invalid') return `${name}: invalid`;
  return `${name}: ${s.mode === 'per-bot' ? 'per-bot' : 'ready'}`;
}

/** Top-bar Docker pill from /api/health. */
export function dockerPill(docker: HealthResponse['docker'] | undefined): {
  tone: PillTone;
  label: string;
  title?: string;
} {
  if (!docker) return { tone: 'neutral', label: 'Docker: …' };
  if (!docker.ok) return { tone: 'error', label: 'Docker: down', title: docker.error };
  if (docker.image === false)
    return { tone: 'warn', label: 'Docker: no image', title: 'Run pnpm image:build' };
  return { tone: 'ok', label: 'Docker: ok', title: docker.version ? `Docker ${docker.version}` : undefined };
}

/** "14:05" in the viewer's local time (24 h). */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** A usage-limit pause still in force at `now`, else null. */
export function activeLimit(limitedUntil: string | null | undefined, now = Date.now()): string | null {
  return limitedUntil && Date.parse(limitedUntil) > now ? limitedUntil : null;
}

export type PillView = { tone: PillTone; label: string; title: string };

/** Top-bar pill for Claude/Codex: a live usage-limit pause wins over the auth status. */
export function enginePill(
  engine: AuthEngine,
  auth: EngineAuthStatus | undefined,
  limitedUntil: string | null | undefined,
  now = Date.now(),
): PillView {
  const name = ENGINE_LABELS[engine];
  const until = activeLimit(limitedUntil, now);
  if (until)
    return {
      tone: 'warn',
      label: `${name}: limited until ${clockTime(until)}`,
      title: `${name} hit its usage limit; its runs are paused until ${new Date(until).toLocaleString()} and resume on their own.`,
    };
  const label = enginePillLabel(auth, engine);
  return {
    tone: auth ? engineView(auth).tone : 'neutral',
    label,
    title: auth ? `${label}. ${auth.detail}` : 'Checking…',
  };
}

/** Shown only while AGENTA_ENGINE_OVERRIDE=mock puts every bot on the mock engine (tests, demos). */
export function mockPill(limitedUntil: string | null | undefined, now = Date.now()): PillView {
  const until = activeLimit(limitedUntil, now);
  const title = 'Engine override: every bot runs on the scripted mock engine (AGENTA_ENGINE_OVERRIDE=mock).';
  return until
    ? {
        tone: 'warn',
        label: `Mock: limited until ${clockTime(until)}`,
        title: `${title} Mock runs are paused.`,
      }
    : { tone: 'neutral', label: 'Mock: on', title };
}
