'use client';

import {
  ENGINE_LABELS,
  type BotView,
  type EngineQueueStateResponse,
  type MessageView,
  type RunView,
} from '@agenta/shared';
import {
  Brain,
  Check,
  ChevronRight,
  Copy,
  HelpCircle,
  FileMinus,
  FilePen,
  FilePlus,
  Pencil,
  RotateCcw,
  Square,
} from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { memo, useEffect, useState } from 'react';
import { BotAvatar } from '@/components/bot-avatar';
import { Markdown } from '@/components/markdown';
import { useShell } from '@/components/shell/shell-context';
import { useRunTimeline } from '@/hooks/use-thread';
import { clockTime } from '@/lib/engines';
import { learnApi } from '@/lib/learn';
import { type RunState, isActiveRun, runState } from '@/lib/threads';
import { type FileChange, type TimelineBlock, timelineText } from '@/lib/timeline';
import { formatDuration, formatTokens } from '@/lib/tools';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { ToolCard } from './tool-card';

function Time({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()} className="text-xs text-muted-foreground">
      {clockTime(iso)}
    </time>
  );
}

const ACTION =
  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50';

/** "Ask Agent A why": the lead explains the reasoning behind this bot message in the same thread (F23). */
function AskWhyButton({ message }: { message: MessageView }) {
  const ask = useMutation({
    mutationFn: () => learnApi.askWhy(message.threadId, message.id),
    onSuccess: () => toast.success('Asked Agent A why'),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not ask Agent A'),
  });
  return (
    <button type="button" className={ACTION} onClick={() => ask.mutate()} disabled={ask.isPending}>
      <HelpCircle className="size-3.5" aria-hidden />
      Ask Agent A why
    </button>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className={ACTION}
      aria-label={`${label} message`}
      data-testid="copy-message"
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => toast.error('Could not copy to the clipboard'),
        )
      }
    >
      {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      {copied ? 'Copied' : label}
    </button>
  );
}

export const UserMessage = memo(function UserMessage({
  message,
  onEdit,
}: {
  message: MessageView;
  /** Set on the latest user message: puts it back in the composer to resend. */
  onEdit?: (message: MessageView) => void;
}) {
  return (
    <div className="group/msg flex justify-end" data-testid="message-user" data-message-id={message.id}>
      <div className="max-w-[85%] space-y-1">
        <div className="rounded-2xl rounded-br-sm bg-primary/10 px-4 py-2.5">
          <Markdown>{message.contentMd}</Markdown>
        </div>
        <div className="flex items-center justify-end gap-1">
          <span className="flex gap-1 opacity-0 transition-opacity group-focus-within/msg:opacity-100 group-hover/msg:opacity-100">
            <CopyButton text={message.contentMd} />
            {onEdit && (
              <button
                type="button"
                className={ACTION}
                onClick={() => onEdit(message)}
                aria-label="Edit and resend"
              >
                <Pencil className="size-3.5" aria-hidden />
                Edit
              </button>
            )}
          </span>
          <Time iso={message.createdAt} />
        </div>
      </div>
    </div>
  );
});

function BotHeader({ bot, at }: { bot: BotView | undefined; at: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium">{bot?.name ?? 'Deleted bot'}</span>
      <Time iso={at} />
    </div>
  );
}

function BotRow({
  bot,
  children,
  ...props
}: { bot: BotView | undefined; children: React.ReactNode } & React.ComponentProps<'div'>) {
  return (
    <div className="group/msg flex gap-3" {...props}>
      {bot ? (
        <BotAvatar name={bot.name} color={bot.avatarColor} shape={bot.avatarShape} size="sm" />
      ) : (
        <span className="size-7 shrink-0 rounded-full bg-muted" aria-hidden />
      )}
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  );
}

/** A bot message whose run is not loaded (older history), or a system note. */
export const PlainMessage = memo(function PlainMessage({
  message,
  bot,
}: {
  message: MessageView;
  bot: BotView | undefined;
}) {
  if (message.authorType === 'system') {
    return (
      <p className="text-center text-xs text-muted-foreground" data-testid="message-system">
        {message.contentMd}
      </p>
    );
  }
  return (
    <BotRow bot={bot} data-testid="message-bot" data-message-id={message.id}>
      <BotHeader bot={bot} at={message.createdAt} />
      <Markdown>{message.contentMd}</Markdown>
      <div className="flex gap-1 opacity-0 transition-opacity group-focus-within/msg:opacity-100 group-hover/msg:opacity-100">
        <CopyButton text={message.contentMd} />
        <AskWhyButton message={message} />
      </div>
    </BotRow>
  );
});

export function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1" data-testid="typing-indicator" aria-label="Typing">
      {[0, 150, 300].map((d) => (
        <span
          key={d}
          className="size-1.5 animate-bounce rounded-full bg-muted-foreground/70"
          style={{ animationDelay: `${d}ms` }}
        />
      ))}
    </span>
  );
}

const TONE_CLASS: Record<RunState['tone'], string> = {
  neutral: 'text-muted-foreground',
  ok: 'text-success',
  warn: 'text-warning',
  error: 'text-destructive',
};

const FILE_ICONS = { created: FilePlus, modified: FilePen, deleted: FileMinus } as const;

function FileChips({ botId, files }: { botId: string; files: FileChange[] }) {
  const { openFile } = useShell();
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Files changed">
      {files.map((f) => {
        const Icon = FILE_ICONS[f.change];
        const name = f.path.split('/').pop() || f.path;
        return (
          <li key={f.path}>
            <button
              type="button"
              title={`${f.change}: ${f.path}`}
              data-testid="file-chip"
              data-change={f.change}
              disabled={f.change === 'deleted'}
              onClick={() => openFile(botId, f.path)}
              className="inline-flex max-w-64 items-center gap-1.5 rounded-md border bg-muted px-2 py-1 font-mono text-xs hover:bg-accent disabled:line-through disabled:opacity-70"
            >
              <Icon
                className={cn(
                  'size-3.5 shrink-0',
                  f.change === 'created' && 'text-success',
                  f.change === 'deleted' && 'text-destructive',
                )}
                aria-hidden
              />
              <span className="truncate">{name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Block({ block, running }: { block: TimelineBlock; running: boolean }) {
  switch (block.kind) {
    case 'text':
      return (
        <div data-testid="turn-text">
          <Markdown>{block.text}</Markdown>
        </div>
      );
    case 'thinking':
      return (
        <details className="group/think text-sm text-muted-foreground" data-testid="thinking">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs select-none [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform group-open/think:rotate-90" aria-hidden />
            <Brain className="size-3.5" aria-hidden />
            Thinking
          </summary>
          <p className="mt-1 border-l-2 pl-3 whitespace-pre-wrap">{block.text}</p>
        </details>
      );
    case 'tool':
      return <ToolCard block={block} running={running} />;
    case 'error':
      return (
        <p className="text-sm text-destructive" data-testid="turn-error">
          {block.message}
        </p>
      );
    case 'system':
      return <p className="text-xs text-muted-foreground italic">{block.message}</p>;
  }
}

/** Engine · duration · tokens · cost-equivalent, for a finished turn. */
function footerParts(run: RunView): string[] {
  const parts: string[] = [ENGINE_LABELS[run.engine]];
  if (run.durationMs !== null) parts.push(formatDuration(run.durationMs));
  const u = run.usage;
  if (u?.inputTokens !== undefined || u?.outputTokens !== undefined) {
    parts.push(`${formatTokens(u.inputTokens ?? 0)} in · ${formatTokens(u.outputTokens ?? 0)} out`);
  }
  if (u?.costUsdEquivalent)
    parts.push(`≈ $${u.costUsdEquivalent.toFixed(u.costUsdEquivalent < 0.1 ? 3 : 2)}`);
  return parts;
}

/**
 * One bot turn: its timeline (text, thinking, tool cards, notes) live or from storage, the files it changed, its
 * state (queued, limited, working, stopped, failed…) and, once finished, a footer with stats and actions.
 */
export function RunTurn({
  run,
  reply,
  bot,
  engines,
  retried,
  onStop,
  stopping,
  onRetry,
  retrying,
}: {
  run: RunView;
  reply: MessageView | undefined;
  bot: BotView | undefined;
  engines: EngineQueueStateResponse | undefined;
  /** A later run re-runs this one (usage limit or Retry). */
  retried: boolean;
  onStop: (runId: string) => void;
  stopping: boolean;
  /** Set on the bot's latest finished turn. */
  onRetry?: (runId: string) => void;
  retrying: boolean;
}) {
  const active = isActiveRun(run);
  const { timeline, loading } = useRunTimeline(run);
  const blocks = timeline?.blocks ?? [];
  const hasText = blocks.some((b) => b.kind === 'text');
  // The stored reply stands in while the timeline loads, or when its events are gone.
  const fallback = !hasText && reply ? reply.contentMd : '';
  const text = timeline ? timelineText(timeline) || fallback : (reply?.contentMd ?? '');
  const state = runState(run, engines, retried);
  // The error is already in the timeline: the state line needn't repeat it.
  if (
    state &&
    run.status === 'failed' &&
    run.error &&
    blocks.some((b) => b.kind === 'error' && b.message === run.error)
  ) {
    state.label = 'Failed';
  }
  const empty = !active && !loading && blocks.length === 0 && !fallback && run.status === 'succeeded';

  return (
    <BotRow bot={bot} data-testid="bot-turn" data-run-id={run.id} data-run-status={run.status}>
      <BotHeader bot={bot} at={reply?.createdAt ?? run.startedAt ?? run.createdAt} />
      {blocks.map((b, i) => (
        <Block key={b.kind === 'tool' ? b.callId : i} block={b} running={active} />
      ))}
      {fallback && (
        <div data-testid="turn-text">
          <Markdown>{fallback}</Markdown>
        </div>
      )}
      {empty && <p className="text-sm text-muted-foreground italic">No reply.</p>}
      {timeline && timeline.files.length > 0 && <FileChips botId={run.botId} files={timeline.files} />}
      {state && (
        <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="run-state">
          {state.typing && <TypingDots />}
          <span className={cn(TONE_CLASS[state.tone])}>{state.label}</span>
          {state.stoppable && (
            <button
              type="button"
              onClick={() => onStop(run.id)}
              disabled={stopping}
              className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            >
              <Square className="size-3" aria-hidden />
              {run.status === 'queued' ? 'Cancel' : 'Stop'}
            </button>
          )}
        </div>
      )}
      {!active && (
        <div
          className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
          data-testid="run-footer"
        >
          <span className="mr-1">{footerParts(run).join(' · ')}</span>
          {text && (
            <span className="flex gap-1 opacity-0 transition-opacity group-focus-within/msg:opacity-100 group-hover/msg:opacity-100">
              <CopyButton text={text} />
              {reply && <AskWhyButton message={reply} />}
            </span>
          )}
          {onRetry && (
            <button
              type="button"
              className={ACTION}
              onClick={() => onRetry(run.id)}
              disabled={retrying}
              data-testid="retry-turn"
            >
              <RotateCcw className="size-3.5" aria-hidden />
              Retry
            </button>
          )}
        </div>
      )}
    </BotRow>
  );
}
