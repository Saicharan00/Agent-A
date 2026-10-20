'use client';

import { FolderTree, ListChecks, MonitorPlay, SquareTerminal, X } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { BotAvatar } from '@/components/bot-avatar';
import { DesktopView } from '@/components/computer/desktop-view';
import { FilesPanel } from '@/components/computer/files-panel';
import { RunsPanel } from '@/components/computer/runs-panel';
import { TerminalPanel } from '@/components/computer/terminal-panel';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { useBots } from '@/hooks/use-bots';
import { cn } from '@/lib/utils';
import { COMPUTER_TABS, type ComputerTab, useShell } from './shell-context';

const TAB_META: Record<ComputerTab, { label: string; icon: typeof SquareTerminal }> = {
  terminal: { label: 'Terminal', icon: SquareTerminal }, // TerminalPanel
  desktop: { label: 'Desktop', icon: MonitorPlay }, // DesktopView
  files: { label: 'Files', icon: FolderTree }, // FilesPanel
  runs: { label: 'Runs', icon: ListChecks }, // RunsPanel
};

export function ComputerPanel() {
  const { computerOpen, setComputerOpen, computerTab, setComputerTab, computerBotId } = useShell();
  // From the (live) bot list, so a bot deleted elsewhere simply drops out of focus.
  const { data: bots } = useBots();
  const bot = bots?.find((b) => b.id === computerBotId);
  // The Files tab mounts on first visit and then stays mounted (like terminals), so an unsaved edit survives
  // switching tabs.
  const [filesMounted, setFilesMounted] = useState(false);
  if (computerOpen && computerTab === 'files' && !filesMounted) setFilesMounted(true);
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
        className="flex min-h-0 flex-1 flex-col"
      >
        {bot && (
          <div className="flex items-center gap-2 px-4 py-2" data-testid="computer-bot">
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
        {/* Always mounted while the panel is open, so shells survive switching tabs and bots. */}
        <TerminalPanel bot={bot} bots={bots} visible={computerTab === 'terminal'} />
        {bot && filesMounted && (
          <FilesPanel key={`files-${bot.id}`} bot={bot} visible={computerTab === 'files'} />
        )}
        {/* Mounted only while shown: a watched desktop keeps the computer awake. */}
        {bot && computerTab === 'desktop' && <DesktopView key={`desktop-${bot.id}`} bot={bot} />}
        {bot && computerTab === 'runs' && (
          <div className="flex flex-1 flex-col overflow-auto px-4 pb-4">
            <RunsPanel key={`runs-${bot.id}`} bot={bot} />
          </div>
        )}
        {computerTab !== 'terminal' && !bot && (
          <div className="flex flex-1 flex-col gap-3 overflow-auto px-4 pb-4">
            <EmptyState
              icon={meta.icon}
              title="No bot selected"
              description={
                computerTab === 'files'
                  ? 'Pick a bot (its Computer button) to browse its files and the team share.'
                  : computerTab === 'desktop'
                    ? 'Pick a bot (its Computer button) to watch its screen.'
                    : 'Pick a bot (its Computer button) to see its runs.'
              }
            />
          </div>
        )}
      </div>
    </aside>
  );
}
