'use client';

import type { BotView } from '@agenta/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Bot, Copy, MessageSquare, Monitor, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BotAvatar } from '@/components/bot-avatar';
import { EmptyState } from '@/components/empty-state';
import { MemoryPanel } from '@/components/memory/memory-panel';
import { Page, PageHeader } from '@/components/page-header';
import { useShell } from '@/components/shell/shell-context';
import { Button, buttonVariants } from '@/components/ui/button';
import { useBot, useBotActions } from '@/hooks/use-bots';
import { ApiClientError } from '@/lib/api';
import { STATUS_LABEL } from '@/lib/avatar';
import { botToForm, botsApi, changedFields, relativeTime } from '@/lib/bots';
import { queryKeys } from '@/lib/query-keys';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { BotForm } from './bot-form';
import { EngineBadge } from './bot-card';
import { DeleteBotDialog } from './delete-bot-dialog';

export function BotDetail({ id }: { id: string }) {
  const { data: bot, error, isPending } = useBot(id);

  if (isPending) {
    return (
      <Page>
        <PageHeader title="Bot" />
        <div className="h-64 animate-pulse rounded-lg border bg-muted/40" aria-busy="true" />
      </Page>
    );
  }
  if (!bot) {
    const notFound = error instanceof ApiClientError && error.status === 404;
    return (
      <Page>
        <PageHeader title="Bot" description={<span className="font-mono text-xs">{id}</span>} />
        <EmptyState
          icon={Bot}
          title={notFound ? 'Bot not found' : 'Could not load the bot'}
          description={notFound ? 'It may have been deleted.' : error?.message}
          action={
            <Link href="/bots" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
              All bots
            </Link>
          }
        />
      </Page>
    );
  }
  return <BotDetailLoaded bot={bot} />;
}

function BotDetailLoaded({ bot }: { bot: BotView }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { openComputer } = useShell();
  const { archive, restore, duplicate } = useBotActions();
  const [deleting, setDeleting] = useState(false);
  const [tab, setTab] = useState<'settings' | 'memory'>('settings');
  const archived = bot.archivedAt !== null;
  const initial = botToForm(bot);

  return (
    <Page>
      <PageHeader
        title={bot.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <BotAvatar
              name={bot.name}
              color={bot.avatarColor}
              shape={bot.avatarShape}
              status={bot.status}
              size="sm"
            />
            <span className="font-mono text-xs">@{bot.slug}</span>
            <EngineBadge engine={bot.engine} model={bot.model} />
            <span>{archived ? 'Archived' : STATUS_LABEL[bot.status]}</span>
            <span aria-hidden>·</span>
            <span>{relativeTime(bot.lastActivityAt)}</span>
          </span>
        }
        actions={
          archived ? (
            <Button size="sm" onClick={() => restore.mutate(bot)} disabled={restore.isPending}>
              <ArchiveRestore /> Restore
            </Button>
          ) : (
            <>
              {bot.dmThreadId && (
                <Link href={`/threads/${bot.dmThreadId}`} className={buttonVariants({ size: 'sm' })}>
                  <MessageSquare /> Chat
                </Link>
              )}
              <Button size="sm" variant="outline" onClick={() => openComputer(bot.id)}>
                <Monitor /> Computer
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => duplicate.mutate(bot)}
                disabled={duplicate.isPending}
              >
                <Copy /> Duplicate
              </Button>
            </>
          )
        }
      />

      {archived && (
        <p role="status" className="rounded-md border border-warning/40 px-3 py-2 text-sm text-warning">
          This bot is archived: its computer is stopped and it is hidden from the sidebar. Restore it to chat
          again.
        </p>
      )}

      <div role="tablist" aria-label="Bot sections" className="flex gap-1 border-b">
        {(['settings', 'memory'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`bot-tab-${t}`}
            aria-selected={tab === t}
            aria-controls={`bot-panel-${t}`}
            onClick={() => setTab(t)}
            className={cn(
              '-mb-px border-b-2 px-3 py-1.5 text-sm capitalize',
              tab === t
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'memory' ? (
        <div role="tabpanel" id="bot-panel-memory" aria-labelledby="bot-tab-memory">
          <MemoryPanel scope="bot" botId={bot.id} />
        </div>
      ) : (
        <div role="tabpanel" id="bot-panel-settings" aria-labelledby="bot-tab-settings" className="space-y-6">
          {/* Re-mounts when the saved settings change (saved here or elsewhere), never on status-only updates. */}
          <BotForm
            key={JSON.stringify(initial)}
            initial={initial}
            base={bot}
            submitLabel="Save changes"
            onSubmit={async (body) => {
              const patch = changedFields(body, bot);
              if (Object.keys(patch).length === 0) {
                toast('No changes to save');
                return;
              }
              const res = await botsApi.update(bot.id, patch);
              qc.setQueryData(queryKeys.bot(bot.id), res.bot);
              void qc.invalidateQueries({ queryKey: queryKeys.bots });
              toast.success('Bot saved');
              if (res.restartRequired)
                toast.warning(
                  'Resource limits apply after the computer restarts (Stop, then start it again).',
                );
            }}
          />

          <section
            aria-labelledby="danger-zone"
            className="space-y-3 rounded-lg border border-destructive/30 p-4"
          >
            <h2 id="danger-zone" className="text-sm font-semibold">
              Danger zone
            </h2>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {archived
                  ? 'Delete removes the bot and its computer for good.'
                  : 'Archive stops the computer and hides the bot, keeping all its data.'}
              </p>
              <div className="flex gap-2">
                {!archived && !bot.isLead && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => archive.mutate(bot)}
                    disabled={archive.isPending}
                  >
                    <Archive /> Archive
                  </Button>
                )}
                {!bot.isLead && (
                  <Button variant="destructive" size="sm" onClick={() => setDeleting(true)}>
                    <Trash2 /> Delete…
                  </Button>
                )}
              </div>
            </div>
          </section>
          <DeleteBotDialog
            bot={bot}
            open={deleting}
            onClose={() => setDeleting(false)}
            onDeleted={() => router.push('/bots')}
          />
        </div>
      )}
    </Page>
  );
}
