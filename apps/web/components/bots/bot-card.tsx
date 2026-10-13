'use client';

import { type BotView, ENGINE_LABELS } from '@agenta/shared';
import { ArchiveRestore, MessageSquare, Monitor, Settings2, Square, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { BotAvatar } from '@/components/bot-avatar';
import { useShell } from '@/components/shell/shell-context';
import { Button, buttonVariants } from '@/components/ui/button';
import { useBotActions } from '@/hooks/use-bots';
import { STATUS_LABEL } from '@/lib/avatar';
import { relativeTime } from '@/lib/bots';
import { cn } from '@/lib/utils';
import { DeleteBotDialog } from './delete-bot-dialog';

export function EngineBadge({ engine, model }: Pick<BotView, 'engine' | 'model'>) {
  return (
    <span className="inline-flex h-5 items-center rounded border px-1.5 text-[11px] font-medium text-muted-foreground">
      {ENGINE_LABELS[engine]}
      {model && <span className="ml-1 font-mono">· {model}</span>}
    </span>
  );
}

export function BotCard({ bot }: { bot: BotView }) {
  const { openComputer } = useShell();
  const { restore, stop } = useBotActions();
  const [deleting, setDeleting] = useState(false);
  const archived = bot.archivedAt !== null;
  const computerOn = bot.status === 'running' || bot.status === 'starting';

  return (
    <article
      aria-label={bot.name}
      data-testid="bot-card"
      className={cn('flex flex-col gap-3 rounded-lg border bg-card p-4', archived && 'opacity-80')}
    >
      <div className="flex items-start gap-3">
        <BotAvatar
          name={bot.name}
          color={bot.avatarColor}
          shape={bot.avatarShape}
          status={archived ? undefined : bot.status}
        />
        <div className="min-w-0 flex-1">
          <Link href={`/bots/${bot.id}`} className="block truncate font-medium hover:underline">
            {bot.name}
          </Link>
          <p className="truncate text-xs text-muted-foreground">{bot.role || `@${bot.slug}`}</p>
        </div>
        {bot.isLead && (
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
            Lead
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <EngineBadge engine={bot.engine} model={bot.model} />
        <span>{archived ? 'Archived' : STATUS_LABEL[bot.status]}</span>
        <span aria-hidden>·</span>
        <span title={bot.lastActivityAt ? new Date(bot.lastActivityAt).toLocaleString() : undefined}>
          {relativeTime(bot.lastActivityAt)}
        </span>
      </div>
      <div className="mt-auto flex flex-wrap gap-1.5">
        {archived ? (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => restore.mutate(bot)}
              disabled={restore.isPending}
            >
              <ArchiveRestore /> Restore
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDeleting(true)}>
              <Trash2 /> Delete
            </Button>
            <DeleteBotDialog bot={bot} open={deleting} onClose={() => setDeleting(false)} />
          </>
        ) : (
          <>
            {bot.dmThreadId && (
              <Link
                href={`/threads/${bot.dmThreadId}`}
                className={buttonVariants({ size: 'sm', variant: 'outline' })}
              >
                <MessageSquare /> Chat
              </Link>
            )}
            <Button size="sm" variant="ghost" onClick={() => openComputer(bot.id)}>
              <Monitor /> Computer
            </Button>
            {computerOn && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => stop.mutate(bot)}
                disabled={stop.isPending}
                aria-label={`Stop ${bot.name}'s computer`}
              >
                <Square /> Stop
              </Button>
            )}
            <Link
              href={`/bots/${bot.id}`}
              aria-label={`${bot.name} settings`}
              className={cn(buttonVariants({ size: 'icon-sm', variant: 'ghost' }), 'ml-auto')}
            >
              <Settings2 />
            </Link>
          </>
        )}
      </div>
    </article>
  );
}
