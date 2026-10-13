'use client';

import { Archive, Bot } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { buttonVariants } from '@/components/ui/button';
import { useBots } from '@/hooks/use-bots';
import { sortBots } from '@/lib/bots';
import { cn } from '@/lib/utils';
import { BotCard } from './bot-card';

const VIEWS = [
  { id: 'exclude', label: 'Active' },
  { id: 'only', label: 'Archived' },
] as const;

export function BotsGrid() {
  const [view, setView] = useState<(typeof VIEWS)[number]['id']>('exclude');
  const { data, isPending, error } = useBots(view);

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Bot filter" className="flex gap-1">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view === v.id}
            onClick={() => setView(v.id)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground',
              view === v.id && 'bg-accent font-medium text-accent-foreground',
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      {error ? (
        <EmptyState icon={Bot} title="Could not load bots" description={error.message} />
      ) : isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-36 animate-pulse rounded-lg border bg-muted/40" />
          ))}
        </div>
      ) : data.length === 0 ? (
        view === 'exclude' ? (
          <EmptyState
            icon={Bot}
            title="No bots yet"
            description="Create your first bot to start a conversation."
            action={
              <Link href="/bots/new" className={buttonVariants({ size: 'sm' })}>
                New bot
              </Link>
            }
          />
        ) : (
          <EmptyState icon={Archive} title="No archived bots" description="Archived bots appear here." />
        )
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sortBots(data).map((bot) => (
            <BotCard key={bot.id} bot={bot} />
          ))}
        </div>
      )}
    </div>
  );
}
