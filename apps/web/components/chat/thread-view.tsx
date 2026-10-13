'use client';

import { type BotView, type MessageView, splitUserMessage } from '@agenta/shared';
import { GraduationCap, MessagesSquare, Monitor, Settings } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { BotAvatar } from '@/components/bot-avatar';
import { EmptyState } from '@/components/empty-state';
import { useShell } from '@/components/shell/shell-context';
import { StatusPill } from '@/components/status-pill';
import { Button } from '@/components/ui/button';
import { useBot } from '@/hooks/use-bots';
import { useLiveChannel } from '@/hooks/use-live-channel';
import {
  useCancelRuns,
  useEngineState,
  useMarkRead,
  useRetryTurn,
  useThread,
  useThreadMessages,
  useThreadRuns,
  useUpdateThread,
} from '@/hooks/use-thread';
import { ApiClientError } from '@/lib/api';
import { ENGINE_LABELS } from '@agenta/shared';
import { STATUS_LABEL } from '@/lib/avatar';
import { buildTranscript, flattenPages, lastUserMessage, retryableRun, stoppableRuns } from '@/lib/threads';
import { cn } from '@/lib/utils';
import { Composer, type ComposerDraft } from './composer';
import { MessageList } from './message-list';

function ThreadHeader({
  bot,
  title,
  explainMode,
  onToggleExplain,
}: {
  bot: BotView | undefined;
  title: string;
  explainMode: boolean | undefined;
  onToggleExplain: () => void;
}) {
  const { openComputer } = useShell();
  return (
    <header className="flex items-center gap-3 border-b px-4 py-2.5">
      {bot && (
        <BotAvatar name={bot.name} color={bot.avatarColor} shape={bot.avatarShape} status={bot.status} />
      )}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold">{bot?.name ?? title}</h1>
        {bot && (
          <p className="truncate text-xs text-muted-foreground">
            {[bot.role, ENGINE_LABELS[bot.engine] + (bot.model ? ` · ${bot.model}` : '')]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
      </div>
      {explainMode !== undefined && (
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={explainMode}
          onClick={onToggleExplain}
          title="Explain mode: the bot says what it is doing and why, and lists takeaways (applies from the next message)"
          className={cn(explainMode && 'bg-primary/15 text-primary hover:bg-primary/20')}
        >
          <GraduationCap aria-hidden />
          Explain
        </Button>
      )}
      {bot && (
        <>
          <StatusPill tone={bot.status === 'running' ? 'ok' : bot.status === 'error' ? 'error' : 'neutral'}>
            {STATUS_LABEL[bot.status]}
          </StatusPill>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open computer"
            onClick={() => openComputer(bot.id)}
          >
            <Monitor aria-hidden />
          </Button>
          <Link
            href={`/bots/${bot.id}`}
            aria-label="Bot settings"
            className="inline-flex size-8 items-center justify-center rounded-md hover:bg-accent [&_svg]:size-4"
          >
            <Settings aria-hidden />
          </Link>
        </>
      )}
    </header>
  );
}

/** A conversation: header, transcript with live bot turns, composer. */
export function ThreadView({ threadId }: { threadId: string }) {
  const thread = useThread(threadId);
  const messages = useThreadMessages(threadId);
  const runs = useThreadRuns(threadId);
  const engines = useEngineState();
  const { stop, pending: stopping } = useCancelRuns();
  const update = useUpdateThread(threadId);
  const retry = useRetryTurn(threadId);
  const [draft, setDraft] = useState<ComposerDraft | null>(null);

  // Thread events (messages, run status) update the cache in LiveProvider.
  useLiveChannel(`thread:${threadId}`);
  const member = thread.data?.members[0];
  useLiveChannel(member ? `bot:${member.id}` : null);
  // The bot detail query is patched live (status); the thread's copy is a snapshot.
  const liveBot = useBot(member?.id ?? '', { enabled: !!member }).data;
  const bot = liveBot ?? member;

  const botsById = useMemo(() => {
    const map = new Map<string, BotView>();
    for (const b of thread.data?.members ?? []) map.set(b.id, b);
    if (liveBot) map.set(liveBot.id, liveBot);
    return map;
  }, [thread.data, liveBot]);

  const active = useMemo(() => stoppableRuns(runs.data ?? []).map((r) => r.id), [runs.data]);
  const onStopOne = useCallback((runId: string) => stop([runId]), [stop]);
  const onLoadOlder = useCallback(() => void messages.fetchNextPage(), [messages]);

  const loaded = useMemo(() => flattenPages(messages.data), [messages.data]);
  const items = useMemo(() => buildTranscript(loaded, runs.data ?? []), [loaded, runs.data]);
  const lastUser = useMemo(() => lastUserMessage(loaded), [loaded]);
  const retryable = useMemo(() => {
    const ids = new Set<string>();
    for (const b of thread.data?.members ?? []) {
      const r = retryableRun(runs.data ?? [], b.id);
      if (r) ids.add(r.id);
    }
    return ids;
  }, [thread.data, runs.data]);
  const onEdit = useCallback(
    (m: MessageView) => setDraft((d) => ({ key: (d?.key ?? 0) + 1, ...splitUserMessage(m.contentMd) })),
    [],
  );
  const onRetry = useCallback((runId: string) => retry.mutate(runId), [retry]);
  const onDraftDone = useCallback(() => setDraft(null), []);

  // Seen while open: clears this thread's unread badge.
  useMarkRead(threadId, loaded[loaded.length - 1]?.id, !!thread.data);

  if (thread.error) {
    const missing = thread.error instanceof ApiClientError && thread.error.status === 404;
    return (
      <div className="p-6">
        <EmptyState
          icon={MessagesSquare}
          title={missing ? 'Conversation not found' : 'Could not load this conversation'}
          description={missing ? 'It may have been deleted with its bot.' : thread.error.message}
          action={
            <Link href="/bots" className="text-sm text-primary underline">
              Go to bots
            </Link>
          }
        />
      </div>
    );
  }

  const disabledReason = thread.data?.archivedAt
    ? 'This conversation is archived.'
    : bot?.archivedAt
      ? `${bot.name} is archived. Restore it to chat.`
      : thread.data && thread.data.kind !== 'dm'
        ? 'Group chats arrive soon.'
        : null;

  return (
    <div className="flex h-full flex-col" data-testid="thread-view">
      <ThreadHeader
        bot={bot}
        title={thread.data?.title ?? 'Conversation'}
        explainMode={thread.data?.explainMode}
        onToggleExplain={() => thread.data && update.mutate({ explainMode: !thread.data.explainMode })}
      />
      <MessageList
        items={items}
        botsById={botsById}
        engines={engines.data}
        hasOlder={!!messages.hasNextPage}
        loadingOlder={messages.isFetchingNextPage}
        onLoadOlder={onLoadOlder}
        onStop={onStopOne}
        stopping={stopping}
        editableMessageId={disabledReason ? null : (lastUser?.id ?? null)}
        onEdit={onEdit}
        retryableRunIds={disabledReason ? new Set() : retryable}
        onRetry={onRetry}
        retrying={retry.isPending}
        empty={
          messages.isPending ? null : (
            <EmptyState
              icon={MessagesSquare}
              title={bot ? `Start a conversation with ${bot.name}` : 'No messages yet'}
              description="Ask for anything. Attach files with the paperclip; they land in the bot's work/inbox folder."
            />
          )
        }
      />
      <Composer
        threadId={threadId}
        botId={thread.data?.kind === 'dm' ? (bot?.id ?? null) : null}
        botName={bot?.name ?? 'the team'}
        disabledReason={thread.data ? disabledReason : 'Loading…'}
        activeRunIds={active}
        onStop={stop}
        stopping={stopping}
        draft={draft}
        onDraftDone={onDraftDone}
      />
    </div>
  );
}
