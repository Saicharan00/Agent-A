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
