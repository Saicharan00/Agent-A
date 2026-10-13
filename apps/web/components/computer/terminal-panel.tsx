'use client';

import type { BotView } from '@agenta/shared';
import { Plus, SquareTerminal, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { addTab, closeTab, MAX_TABS, pruneBots, type TerminalTabs } from '@/lib/terminal-tabs';
import { cn } from '@/lib/utils';
import { TerminalView } from './terminal-view';

/**
 * Terminal tabs for every bot the owner opened one for. All shells stay mounted (hidden) while the panel is open,
 * so switching bots or computer tabs keeps them; closing a tab (or the panel) ends its shell.
 */
export function TerminalPanel({
  bot,
  bots,
  visible,
}: {
  bot: BotView | undefined;
  /** Undefined while loading (nothing is pruned then). */
  bots: BotView[] | undefined;
  visible: boolean;
}) {
  const [tabs, setTabs] = useState<TerminalTabs>({});

  // A deleted or archived bot's shells go away with it.
  useEffect(() => {
    if (bots) setTabs((t) => pruneBots(t, new Set(bots.filter((b) => !b.archivedAt).map((b) => b.id))));
  }, [bots]);

  const mine = bot ? tabs[bot.id] : undefined;
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', !visible && 'hidden')}>
      {bot && mine && mine.list.length > 0 && (
        <div
          className="flex h-8 shrink-0 items-center gap-0.5 border-b px-1"
          role="tablist"
          aria-label="Terminals"
        >
          {mine.list.map((t) => {
            const selected = t.key === mine.active;
            return (
              <div
                key={t.key}
                className={cn(
                  'group flex h-6 items-center rounded text-xs text-muted-foreground',
                  selected && 'bg-accent text-accent-foreground',
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className="h-full px-2 font-mono"
                  onClick={() => setTabs((s) => ({ ...s, [bot.id]: { ...mine, active: t.key } }))}
                >
                  {t.title}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${t.title}`}
                  className="mr-0.5 rounded p-0.5 opacity-60 hover:bg-background/60 hover:opacity-100"
                  onClick={() => setTabs((s) => closeTab(s, bot.id, t.key))}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </div>
            );
          })}
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6"
            aria-label="New terminal"
            disabled={mine.list.length >= MAX_TABS}
            onClick={() => setTabs((s) => addTab(s, bot.id))}
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      )}
      {Object.entries(tabs).flatMap(([botId, t]) =>
        t.list.map((tab) => (
          <TerminalView
            key={tab.key}
            botId={botId}
            visible={visible && botId === bot?.id && tab.key === t.active}
          />
        )),
      )}
      {(!mine || mine.list.length === 0) && (
        <div className="p-4">
          <EmptyState
            icon={SquareTerminal}
            title={bot ? `${bot.name}'s terminal` : 'Terminal'}
            description={
              bot
                ? 'A shell (bash, user bot) in this bot’s computer. Opening one starts the computer if it is stopped.'
                : 'Pick a bot to open a shell in its computer.'
            }
            action={
              bot ? (
                <Button size="sm" onClick={() => setTabs((s) => addTab(s, bot.id))}>
                  <SquareTerminal />
                  Open terminal
                </Button>
              ) : undefined
            }
          />
        </div>
      )}
    </div>
  );
}
