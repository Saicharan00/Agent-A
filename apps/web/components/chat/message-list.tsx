'use client';

import type { BotView, EngineQueueStateResponse, MessageView } from '@agenta/shared';
import { Loader2 } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import type { TranscriptItem } from '@/lib/threads';
import { PlainMessage, RunTurn, UserMessage } from './message-items';

/** Within this many px of the bottom the list follows new content (streaming, new messages). */
const STICK_PX = 80;

/**
 * The transcript. Pages older history in when the top is reached (keeping the scroll position) and follows new
 * content while the reader is at the bottom. Off-screen rows skip rendering work via `content-visibility: auto`.
 */
export function MessageList({
  items,
  botsById,
  engines,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onStop,
  stopping,
  editableMessageId,
  onEdit,
  retryableRunIds,
  onRetry,
  retrying,
  empty,
}: {
  items: TranscriptItem[];
  botsById: Map<string, BotView>;
  engines: EngineQueueStateResponse | undefined;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onStop: (runId: string) => void;
  stopping: boolean;
  /** The latest user message (Edit and resend). */
  editableMessageId: string | null;
  onEdit: (message: MessageView) => void;
  /** Each bot's latest finished turn (Retry). */
  retryableRunIds: ReadonlySet<string>;
  onRetry: (runId: string) => void;
  retrying: boolean;
  empty: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  /** Set just before older messages load: restores the reader's position once they render above. */
  const anchor = useRef<{ height: number; top: number } | null>(null);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  }, []);

  // Follow growth (new rows, streamed text, highlighted code) while stuck to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (anchor.current) return;
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  const firstKey = items[0] ? keyOf(items[0]) : null;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (anchor.current) {
      // Restore once the older page has rendered (or the load failed: then nothing moved).
      if (loadingOlder) return;
      el.scrollTop = el.scrollHeight - anchor.current.height + anchor.current.top;
      anchor.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [firstKey, items.length, loadingOlder]);

  const loadOlder = useCallback(() => {
    const el = scrollRef.current;
    if (!hasOlder || loadingOlder || !el) return;
    anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    onLoadOlder();
  }, [hasOlder, loadingOlder, onLoadOlder]);

  // Reaching the top loads the previous page.
  useEffect(() => {
    const el = topRef.current;
    if (!el || !hasOlder) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !stick.current) loadOlder();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasOlder, loadOlder]);

  const retriedRuns = new Set(
    items.flatMap((i) => (i.kind === 'run' && i.run.retryOfRunId ? [i.run.retryOfRunId] : [])),
  );

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto"
      data-testid="message-list"
    >
      <div ref={contentRef} className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
        <div ref={topRef} className="flex justify-center">
          {hasOlder && (
            <Button variant="ghost" size="sm" onClick={loadOlder} disabled={loadingOlder}>
              {loadingOlder && <Loader2 className="animate-spin" aria-hidden />}
              Load older messages
            </Button>
          )}
        </div>
        {items.length === 0 && empty}
        {items.map((item) => (
          <div key={keyOf(item)} className="[contain-intrinsic-size:auto_96px] [content-visibility:auto]">
            {item.kind === 'message' ? (
              item.message.authorType === 'user' ? (
                <UserMessage
                  message={item.message}
                  onEdit={item.message.id === editableMessageId ? onEdit : undefined}
                />
              ) : (
                <PlainMessage
                  message={item.message}
                  bot={item.message.authorBotId ? botsById.get(item.message.authorBotId) : undefined}
                />
              )
            ) : (
              <RunTurn
                run={item.run}
                reply={item.reply}
                bot={botsById.get(item.run.botId)}
                engines={engines}
                retried={retriedRuns.has(item.run.id)}
                onStop={onStop}
                stopping={stopping}
                onRetry={retryableRunIds.has(item.run.id) ? onRetry : undefined}
                retrying={retrying}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function keyOf(item: TranscriptItem): string {
  return item.kind === 'message' ? item.message.id : item.run.id;
}
