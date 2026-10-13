'use client';

import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from '@agenta/shared';
import { Loader2, Paperclip, Send, Square, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { KeyboardShortcut } from '@/components/keyboard-shortcut';
import { Button } from '@/components/ui/button';
import { useSendMessage } from '@/hooks/use-thread';
import { matchesShortcut, SHORTCUTS } from '@/lib/shortcuts';
import { threadsApi } from '@/lib/threads';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

type Attachment = {
  key: string;
  file: File;
  state: 'uploading' | 'done' | 'error';
  name?: string;
  error?: string;
};

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
}: {
  threadId: string;
  /** Where attachments go (the DM's bot); null disables attaching. */
  botId: string | null;
  botName: string;
  disabledReason: string | null;
  activeRunIds: string[];
  onStop: (runIds: string[]) => void;
  stopping: boolean;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const send = useSendMessage(threadId);

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
      setFiles((fs) => [...fs, { key, file, state: 'uploading' }]);
      threadsApi
        .upload(botId, file)
        .then((res) =>
          setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, state: 'done', name: res.name } : f))),
        )
        .catch((err: unknown) => {
          const error = err instanceof Error ? err.message : 'Upload failed';
          setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, state: 'error', error } : f)));
          toast.error(`${file.name}: ${error}`);
        });
    }
  };

  const submit = () => {
    if (!canSend) return;
    send.mutate(
      { content: text, attachments: ready.map((f) => f.name!) },
      {
        onSuccess: () => {
          setText('');
          setFiles([]);
          inputRef.current?.focus();
        },
        onError: (err) => void toast.error(err instanceof Error ? err.message : 'Could not send'),
      },
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matchesShortcut(e, SHORTCUTS.send) || (e.metaKey && e.key === 'Enter')) {
      e.preventDefault();
      submit();
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
                  f.state === 'error' && 'border-destructive/50 text-destructive',
                )}
              >
                {f.state === 'uploading' ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                ) : (
                  <Paperclip className="size-3" aria-hidden />
                )}
                <span className="truncate">{f.name ?? f.file.name}</span>
                <span className="text-muted-foreground">{formatBytes(f.file.size)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${f.file.name}`}
                  onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}
                  className="rounded hover:bg-accent"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
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
          <Button size="sm" onClick={submit} disabled={!canSend} aria-label="Send">
            {send.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
