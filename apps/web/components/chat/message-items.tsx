'use client';

import type { BotView, EngineQueueStateResponse, MessageView, RunView } from '@agenta/shared';
import { Square } from 'lucide-react';
import { memo } from 'react';
import { BotAvatar } from '@/components/bot-avatar';
import { Markdown } from '@/components/markdown';
import { useRunStream } from '@/hooks/use-thread';
import { clockTime } from '@/lib/engines';
import { type RunState, isActiveRun, runState, streamText } from '@/lib/threads';
import { cn } from '@/lib/utils';

function Time({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()} className="text-xs text-muted-foreground">
      {clockTime(iso)}
    </time>
  );
}

export const UserMessage = memo(function UserMessage({ message }: { message: MessageView }) {
  return (
    <div className="flex justify-end" data-testid="message-user" data-message-id={message.id}>
      <div className="max-w-[85%] space-y-1">
        <div className="rounded-2xl rounded-br-sm bg-primary/10 px-4 py-2.5">
          <Markdown>{message.contentMd}</Markdown>
        </div>
        <div className="text-right">
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
    <div className="flex gap-3" {...props}>
      {bot ? (
        <BotAvatar name={bot.name} color={bot.avatarColor} shape={bot.avatarShape} size="sm" />
      ) : (
        <span className="size-7 shrink-0 rounded-full bg-muted" aria-hidden />
      )}
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
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

/** One bot turn: its streamed or stored reply and its state (queued, limited, working, stopped, failed…). */
export function RunTurn({
  run,
  reply,
  bot,
  engines,
  retried,
  onStop,
  stopping,
}: {
  run: RunView;
  reply: MessageView | undefined;
  bot: BotView | undefined;
  engines: EngineQueueStateResponse | undefined;
  /** A later run re-runs this one (usage limit). */
  retried: boolean;
  onStop: (runId: string) => void;
  stopping: boolean;
}) {
  const active = isActiveRun(run);
  const stream = useRunStream(run.id, active);
  const live = streamText(stream);
  // While the run is active the stream is ahead of the stored reply; afterwards the stored reply is final.
  const text = active ? live || reply?.contentMd || '' : (reply?.contentMd ?? live);
  const state = runState(run, engines, retried);
  const empty = !text && !active && run.status === 'succeeded';

  return (
    <BotRow bot={bot} data-testid="bot-turn" data-run-id={run.id} data-run-status={run.status}>
      <BotHeader bot={bot} at={reply?.createdAt ?? run.startedAt ?? run.createdAt} />
      {text && (
        <div data-testid="turn-text">
          <Markdown>{text}</Markdown>
        </div>
      )}
      {empty && <p className="text-sm text-muted-foreground italic">No reply.</p>}
      {state && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5 text-xs" data-testid="run-state">
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
    </BotRow>
  );
}
