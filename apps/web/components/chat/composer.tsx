'use client';

import { type BotView, type GuardCheckResponse, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from '@agenta/shared';
import { Loader2, Paperclip, Send, ShieldAlert, Square, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { BotAvatar } from '@/components/bot-avatar';
import { KeyboardShortcut } from '@/components/keyboard-shortcut';
import { Button } from '@/components/ui/button';
import { useSendMessage } from '@/hooks/use-thread';
import { ApiClientError } from '@/lib/api';
import { guardApi } from '@/lib/guard';
import { matchesShortcut, SHORTCUTS } from '@/lib/shortcuts';
import { insertMention, mentionAt, mentionCandidates, threadsApi } from '@/lib/threads';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { GuardDialog } from './guard-dialog';

type Attachment = {
  key: string;
  /** Shown name (the browser's until the upload returns the stored one). */
  label: string;
  /** Unknown for files already in the inbox (edit and resend). */
  size?: number;
  /** `flagged`: the confidentiality guard stopped the upload; the owner can upload it anyway. */
  state: 'uploading' | 'done' | 'error' | 'flagged';
  name?: string;
  error?: string;
  /** Kept for "Upload anyway". */
  file?: File;
};

/** Text and inbox files to put back in the composer (Edit on the last message). `key` changes per request. */
export type ComposerDraft = { key: number; content: string; attachments: string[] };

let nextKey = 0;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Message box: multiline, Ctrl+Enter sends, files are uploaded to the bot's inbox as soon as they are picked
 * (or dropped) and referenced by the message. Stop cancels the thread's queued and running turns.
 */
export function Composer({
  threadId,
  botId,
  botName,
  disabledReason,
  activeRunIds,
  onStop,
  stopping,
  draft,
  onDraftDone,
  mentionable,
}: {
  threadId: string;
  /** Group chats: the members `@` autocompletes. */
  mentionable?: BotView[];
  /** Where attachments go (the DM's bot); null disables attaching. */
  botId: string | null;
  botName: string;
  disabledReason: string | null;
  activeRunIds: string[];
  onStop: (runIds: string[]) => void;
  stopping: boolean;
  draft: ComposerDraft | null;
  /** The draft was sent or dismissed. */
  onDraftDone: () => void;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const send = useSendMessage(threadId);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const mention = mentionable ? mentionAt(text, caret) : null;
  const candidates = mention && mentionable ? mentionCandidates(mentionable, mention.query) : [];
  const suggesting = candidates.length > 0 && dismissedAt !== mention?.start;
  const pick = (bot: BotView) => {
    if (!mention) return;
    const next = insertMention(text, caret, mention.start, bot.slug);
    setText(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(next.caret, next.caret));
  };

  // Edit and resend: load the draft once per request.
  const draftKey = draft?.key;
  useEffect(() => {
    if (!draft) return;
    setText(draft.content);
    setFiles(
      draft.attachments.map((name) => ({
        key: String(++nextKey),
        label: name,
        name,
        state: 'done' as const,
      })),
    );
    inputRef.current?.focus();
    // Only a new draft (key) reloads it; edits to the text afterwards are the user's.
  }, [draftKey]);

  // Grow with the text up to ~10 lines.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const uploading = files.some((f) => f.state === 'uploading');
  const ready = files.filter((f) => f.state === 'done');
  const canSend =
    !disabledReason && !send.isPending && !uploading && (text.trim() !== '' || ready.length > 0);

  const addFiles = (list: FileList | File[]) => {
    if (!botId) return;
    const picked = [...list];
    const room = MAX_ATTACHMENTS - files.length;
    if (picked.length > room) toast.error(`Up to ${MAX_ATTACHMENTS} files per message`);
    for (const file of picked.slice(0, Math.max(0, room))) {
      const key = String(++nextKey);
      if (file.size > MAX_ATTACHMENT_BYTES) {
        toast.error(`${file.name} is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}`);
        continue;
      }
      setFiles((fs) => [...fs, { key, label: file.name, size: file.size, state: 'uploading' }]);
      upload(key, file, false);
    }
  };

  const upload = (key: string, file: File, allowFlagged: boolean) => {
    if (!botId) return;
    const patch = (p: Partial<Attachment>) =>
      setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, ...p } : f)));
    patch({ state: 'uploading', error: undefined });
    threadsApi
      .upload(botId, file, allowFlagged)
      .then((res) => patch({ state: 'done', name: res.name, file: undefined }))
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : 'Upload failed';
        const flagged = err instanceof ApiClientError && err.code === 'guard_blocked';
        patch(flagged ? { state: 'flagged', error, file } : { state: 'error', error });
        toast.error(`${file.name}: ${error}`);
      });
  };

  const [review, setReview] = useState<GuardCheckResponse | null>(null);
  const [checking, setChecking] = useState(false);

  const deliver = (content: string, guardOverride: boolean) => {
    send.mutate(
      { content, attachments: ready.map((f) => f.name!), guardOverride },
      {
        onSuccess: () => {
          setText('');
          setFiles([]);
          setReview(null);
          if (draft) onDraftDone();
          inputRef.current?.focus();
        },
        onError: (err) => void toast.error(err instanceof Error ? err.message : 'Could not send'),
      },
    );
  };

  // The confidentiality guard checks the text first; findings open the warning instead of sending.
  const submit = async () => {
    if (!canSend || checking) return;
    if (!text.trim()) return deliver(text, false);
    setChecking(true);
    try {
      const res = await guardApi.check(text);
      if (res.findings.length) setReview(res);
      else deliver(text, false);
    } catch (err) {
      toast.error(`Confidentiality check failed, not sent: ${err instanceof Error ? err.message : 'error'}`);
    } finally {
      setChecking(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggesting) {
      const n = candidates.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => (h + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        return;
      }
      if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') {
        e.preventDefault();
        pick(candidates[Math.min(highlight, n - 1)]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedAt(mention!.start);
        return;
      }
    }
    if (matchesShortcut(e, SHORTCUTS.send) || (e.metaKey && e.key === 'Enter')) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="border-t bg-background/80 px-4 py-3">
      <div
        className={cn(
          'mx-auto w-full max-w-3xl rounded-xl border bg-card shadow-sm focus-within:ring-2 focus-within:ring-ring',
          dragging && 'ring-2 ring-primary',
        )}
        onDragOver={(e) => {
          if (!botId || disabledReason) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          setDragging(false);
          if (!botId || disabledReason || e.dataTransfer.files.length === 0) return;
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }}
      >
        {draft && (
          <div
            className="flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground"
            data-testid="editing-banner"
          >
            <span className="flex-1">Editing your last message: sending posts it again as a new turn.</span>
            <button
              type="button"
              className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                setText('');
                setFiles([]);
                onDraftDone();
              }}
            >
              Cancel
            </button>
          </div>
        )}
        {files.length > 0 && (
          <ul className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Attachments">
            {files.map((f) => (
              <li
                key={f.key}
                data-testid="attachment-chip"
                data-state={f.state}
                title={f.error}
                className={cn(
                  'inline-flex max-w-60 items-center gap-1.5 rounded-md border bg-muted px-2 py-1 text-xs',
                  (f.state === 'error' || f.state === 'flagged') && 'border-destructive/50 text-destructive',
                )}
              >
                {f.state === 'uploading' ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                ) : f.state === 'flagged' ? (
                  <ShieldAlert className="size-3" aria-hidden />
                ) : (
                  <Paperclip className="size-3" aria-hidden />
                )}
                <span className="truncate">{f.name ?? f.label}</span>
                {f.size !== undefined && <span className="text-muted-foreground">{formatBytes(f.size)}</span>}
                {f.state === 'flagged' && f.file && (
                  <button
                    type="button"
                    className="rounded px-1 underline hover:bg-accent"
                    onClick={() => upload(f.key, f.file!, true)}
                  >
                    Upload anyway
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${f.label}`}
                  onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}
                  className="rounded hover:bg-accent"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        {suggesting && (
          <ul
            role="listbox"
            aria-label="Mention a bot"
            className="mx-2 mt-2 max-h-56 overflow-y-auto rounded-lg border bg-popover p-1 shadow-md"
          >
            {candidates.map((bot, i) => (
              <li
                key={bot.id}
                role="option"
                aria-selected={i === highlight}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep the textarea focused
                  pick(bot);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                  i === highlight && 'bg-accent text-accent-foreground',
                )}
              >
                <BotAvatar name={bot.name} color={bot.avatarColor} shape={bot.avatarShape} size="sm" />
                <span className="font-medium">{bot.name}</span>
                <span className="text-xs text-muted-foreground">@{bot.slug}</span>
                {bot.role && <span className="truncate text-xs text-muted-foreground">· {bot.role}</span>}
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            setHighlight(0);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={!!disabledReason}
          placeholder={disabledReason ?? `Message ${botName}…`}
          aria-label={`Message ${botName}`}
          className="block max-h-60 w-full resize-none bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        <div className="flex items-center gap-2 px-2 pb-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            data-testid="attach-input"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Attach files"
            title="Attach files (they go to the bot's work/inbox folder)"
            disabled={!botId || !!disabledReason}
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip aria-hidden />
          </Button>
          <span className="flex-1" />
          <span className="hidden text-xs text-muted-foreground sm:inline">
            <KeyboardShortcut combo={SHORTCUTS.send} /> to send
          </span>
          {activeRunIds.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onStop(activeRunIds)}
              disabled={stopping}
              data-testid="composer-stop"
            >
              <Square aria-hidden />
              Stop
            </Button>
          )}
          <Button size="sm" onClick={() => void submit()} disabled={!canSend || checking} aria-label="Send">
            {send.isPending || checking ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Send aria-hidden />
            )}
            Send
          </Button>
        </div>
      </div>
      <GuardDialog
        findings={review?.findings ?? null}
        busy={send.isPending}
        onEdit={() => {
          setReview(null);
          inputRef.current?.focus();
        }}
        onRedact={() => review && deliver(review.redacted, false)}
        onSendAnyway={() => deliver(text, true)}
      />
    </div>
  );
}
