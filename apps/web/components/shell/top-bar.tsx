'use client';

import { useQuery } from '@tanstack/react-query';
import { Monitor, Moon, Search, Sun } from 'lucide-react';
import { ApprovalsBell } from '@/components/approvals/approvals-bell';
import { KeyboardShortcut } from '@/components/keyboard-shortcut';
import { StatusPill } from '@/components/status-pill';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { dockerPill, enginePill, mockPill, type PillView } from '@/lib/engines';
import { queryKeys } from '@/lib/query-keys';
import { fetchRunnerStatus } from '@/lib/runner';
import { SHORTCUTS } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { useShell } from './shell-context';

/**
 * "Claude: ready" → name always shown, ": ready" only when there's room (the dot's colour still tells the state,
 * and the full text is in the tooltip).
 */
function PillText({ label }: { label: string }) {
  const { computerOpen } = useShell();
  const i = label.indexOf(':');
  if (i < 0) return label;
  return (
    <span>
      {label.slice(0, i)}
      <span className={cn('hidden', computerOpen ? '2xl:inline' : 'lg:inline')}>{label.slice(i)}</span>
    </span>
  );
}

function RunnerPill() {
  const { data } = useQuery({
    queryKey: queryKeys.runnerStatus,
    queryFn: () => fetchRunnerStatus(),
    refetchInterval: 15_000,
  });
  const label = data === undefined ? 'checking…' : data.state === 'ok' ? 'ok' : 'down';
  return (
    <StatusPill
      data-testid="runner-status"
      tone={data === undefined ? 'neutral' : data.state === 'ok' ? 'ok' : 'error'}
      title={data?.state === 'down' ? `Runner: down (${data.reason})` : `Runner: ${label}`}
    >
      <PillText label={`Runner: ${label}`} />
    </StatusPill>
  );
}

function Pill({ testId, view }: { testId: string; view: PillView }) {
  return (
    <StatusPill data-testid={testId} tone={view.tone} title={view.title}>
      <PillText label={view.label} />
    </StatusPill>
  );
}

/**
 * Auth status (F06) plus live queue state (F11): `engine.state` events on the global channel patch the
 * engine-state query, so a usage-limit pause shows at once; the slow poll lets an expired pause fall off.
 */
function EnginePills() {
  const { data: auth } = useQuery({
    queryKey: queryKeys.engineAuth,
    queryFn: () => api.engines(),
    refetchInterval: 60_000,
  });
  const { data: queue } = useQuery({
    queryKey: queryKeys.engineState,
    queryFn: () => api.engineState(),
    refetchInterval: 30_000,
  });
  const limitOf = (engine: string) => queue?.engines.find((e) => e.engine === engine)?.limitedUntil;
  return (
    <>
      {(['claude', 'codex'] as const).map((engine) => (
        <Pill
          key={engine}
          testId={`${engine}-status`}
          view={enginePill(
            engine,
            auth?.engines.find((e) => e.engine === engine),
            limitOf(engine),
          )}
        />
      ))}
      {queue?.override === 'mock' && <Pill testId="mock-status" view={mockPill(limitOf('mock'))} />}
    </>
  );
}

function DockerPill() {
  const { data } = useQuery({
    queryKey: queryKeys.runnerStatus,
    queryFn: () => fetchRunnerStatus(),
    refetchInterval: 15_000,
  });
  const pill = dockerPill(data?.state === 'ok' ? data.health.docker : undefined);
  return (
    <StatusPill
      data-testid="docker-status"
      tone={pill.tone}
      title={pill.title ? `${pill.label} (${pill.title})` : pill.label}
    >
      <PillText label={pill.label} />
    </StatusPill>
  );
}

export function TopBar() {
  const { theme, toggleTheme, computerOpen, setComputerOpen, setPaletteOpen } = useShell();

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        className="flex h-8 w-full max-w-md min-w-40 items-center gap-2 rounded-md border bg-muted/40 px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted"
        aria-label="Search and commands"
      >
        <Search className="size-4 shrink-0" aria-hidden />
        <span className="flex-1 truncate text-left">Search threads, tasks, commands…</span>
        <KeyboardShortcut combo={SHORTCUTS.palette} className="hidden sm:inline-flex" />
      </button>

      <div className="ml-auto flex items-center gap-2">
        {/* Engine pills: auth status (F06) + live usage-limit pauses (F11). */}
        {/* Narrow windows (or the Computer panel open) shrink pills to dot + name; see PillText. */}
        <div className="hidden items-center gap-1.5 sm:flex" aria-label="Engine status">
          <EnginePills />
          <DockerPill />
          <RunnerPill />
        </div>

        <ApprovalsBell />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          title="Toggle theme"
          data-testid="theme-toggle"
        >
          {theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
        <Button
          variant={computerOpen ? 'secondary' : 'ghost'}
          size="icon-sm"
          onClick={() => setComputerOpen(!computerOpen)}
          aria-label={computerOpen ? 'Close computer panel' : 'Open computer panel'}
          aria-pressed={computerOpen}
          aria-controls="computer-panel"
          title={`Computer (${SHORTCUTS.toggleComputer})`}
        >
          <Monitor />
        </Button>
      </div>
    </header>
  );
}
