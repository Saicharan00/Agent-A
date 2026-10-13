'use client';

import { FolderTree, ListChecks, MonitorPlay, SquareTerminal, X } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { BotAvatar } from '@/components/bot-avatar';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { useBots } from '@/hooks/use-bots';
import { cn } from '@/lib/utils';
import { COMPUTER_TABS, type ComputerTab, useShell } from './shell-context';

const TAB_META: Record<ComputerTab, { label: string; icon: typeof SquareTerminal; feature: string }> = {
  terminal: { label: 'Terminal', icon: SquareTerminal, feature: 'F14' },
  desktop: { label: 'Desktop', icon: MonitorPlay, feature: 'F16' },
  files: { label: 'Files', icon: FolderTree, feature: 'F15' },
  runs: { label: 'Runs', icon: ListChecks, feature: 'F10' },
};

export function ComputerPanel() {
  const { computerOpen, setComputerOpen, computerTab, setComputerTab, computerBotId } = useShell();
  // From the (live) bot list, so a bot deleted elsewhere simply drops out of focus.
  const { data: bots } = useBots();
  const bot = bots?.find((b) => b.id === computerBotId);
  if (!computerOpen) return null;

  // Arrow-key navigation between tabs (WAI-ARIA tabs pattern).
  function onTabKey(ev: KeyboardEvent<HTMLButtonElement>) {
    if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
    const i = COMPUTER_TABS.indexOf(computerTab);
    const next =
      COMPUTER_TABS[(i + (ev.key === 'ArrowRight' ? 1 : -1) + COMPUTER_TABS.length) % COMPUTER_TABS.length]!;
    setComputerTab(next);
    document.getElementById(`computer-tab-${next}`)?.focus();
  }

  const meta = TAB_META[computerTab];
  return (
    <aside
      id="computer-panel"
      aria-label="Computer"
      className="flex h-full w-[400px] shrink-0 flex-col border-l bg-panel 2xl:w-[520px]"
    >
      <div className="flex h-12 items-center gap-1 border-b px-2">
        <div role="tablist" aria-label="Computer views" className="flex flex-1 items-center gap-1">
          {COMPUTER_TABS.map((tab) => {
            const { label, icon: Icon } = TAB_META[tab];
            const selected = tab === computerTab;
            return (
              <button
                key={tab}
                id={`computer-tab-${tab}`}
                role="tab"
                type="button"
                aria-selected={selected}
                aria-controls="computer-tabpanel"
                tabIndex={selected ? 0 : -1}
                onClick={() => setComputerTab(tab)}
                onKeyDown={onTabKey}
                className={cn(
                  'flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground',
                  selected && 'bg-accent text-accent-foreground',
                )}
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </button>
            );
          })}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setComputerOpen(false)}
          aria-label="Close computer panel"
        >
          <X />
        </Button>
      </div>
      <div
        id="computer-tabpanel"
        role="tabpanel"
        aria-labelledby={`computer-tab-${computerTab}`}
        className="flex flex-1 flex-col gap-3 overflow-auto p-4"
      >
        {bot && (
          <div className="flex items-center gap-2" data-testid="computer-bot">
            <BotAvatar
              name={bot.name}
              color={bot.avatarColor}
              shape={bot.avatarShape}
              status={bot.status}
              size="sm"
            />
            <span className="truncate text-sm font-medium">{bot.name}</span>
          </div>
        )}
        <EmptyState
          icon={meta.icon}
          title={`${meta.label} not connected`}
          description={
            bot
              ? `${bot.name}'s ${meta.label.toLowerCase()} arrives in ${meta.feature}.`
              : `Pick a bot to see its ${meta.label.toLowerCase()}. Arrives in ${meta.feature}.`
          }
        />
      </div>
    </aside>
  );
}
