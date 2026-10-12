'use client';

import { useQuery } from '@tanstack/react-query';
import { Bell, Monitor, Moon, Search, Sun } from 'lucide-react';
import { KeyboardShortcut } from '@/components/keyboard-shortcut';
import { StatusPill } from '@/components/status-pill';
import { Button } from '@/components/ui/button';
import { ENGINES_QUERY_KEY } from '@/components/settings/engines-section';
import { api } from '@/lib/api';
import { ENGINE_LABELS, dockerPill, enginePillLabel, engineView } from '@/lib/engines';
import { fetchRunnerStatus } from '@/lib/runner';
import { SHORTCUTS } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { useShell } from './shell-context';

function RunnerPill() {
  const { data } = useQuery({
    queryKey: ['runner-status'],
    queryFn: () => fetchRunnerStatus(),
    refetchInterval: 15_000,
  });
  const label = data === undefined ? 'checking…' : data.state === 'ok' ? 'ok' : 'down';
  return (
    <StatusPill
      data-testid="runner-status"
      tone={data === undefined ? 'neutral' : data.state === 'ok' ? 'ok' : 'error'}
      title={data?.state === 'down' ? data.reason : undefined}
    >
      Runner: {label}
    </StatusPill>
  );
}

function EnginePills() {
  const { data } = useQuery({
    queryKey: ENGINES_QUERY_KEY,
    queryFn: () => api.engines(),
    refetchInterval: 60_000,
  });
  return (
    <>
      {(['claude', 'codex'] as const).map((engine) => {
        const s = data?.engines.find((e) => e.engine === engine);
        return (
          <StatusPill
            key={engine}
            data-testid={`${engine}-status`}
            tone={s ? engineView(s).tone : 'neutral'}
            title={s ? `${ENGINE_LABELS[engine]}: ${s.detail}` : 'Checking…'}
          >
            {enginePillLabel(s, engine)}
          </StatusPill>
        );
      })}
    </>
  );
}

function DockerPill() {
  const { data } = useQuery({
    queryKey: ['runner-status'],
    queryFn: () => fetchRunnerStatus(),
    refetchInterval: 15_000,
  });
  const pill = dockerPill(data?.state === 'ok' ? data.health.docker : undefined);
  return (
    <StatusPill data-testid="docker-status" tone={pill.tone} title={pill.title}>
      {pill.label}
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
        {/* Engine pills show auth status (F06); rate-limit state joins them in F10/F28. */}
        {/* With the Computer panel open the centre column is narrow; keep the search usable. */}
        <div
          className={cn('hidden items-center gap-1.5', computerOpen ? '2xl:flex' : 'lg:flex')}
          aria-label="Engine status"
        >
          <EnginePills />
          <DockerPill />
          <RunnerPill />
        </div>

        <Button variant="ghost" size="icon-sm" aria-label="Notifications" title="Notifications">
          <Bell />
        </Button>
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
