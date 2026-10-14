'use client';

import type { MemoryScope, MemoryView } from '@agenta/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Brain, Pencil, Pin, PinOff, Plus, Search, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea, invalidProps } from '@/components/ui/form';
import { relativeTime } from '@/lib/bots';
import { memoriesApi, parseTags } from '@/lib/memories';
import { queryKeys } from '@/lib/query-keys';
import { toast } from '@/lib/toast';

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong');

/**
 * A bot's memories (`botId`) or the team's shared knowledge: search, add, edit, pin and delete. Pinned memories are
 * always in the bot's instruction files; the rest fill the ~2,000-word budget newest first.
 */
export function MemoryPanel({ scope, botId }: { scope: MemoryScope; botId?: string }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<MemoryView | 'new'>();
  const [deleting, setDeleting] = useState<MemoryView>();
  const filter = { scope, botId, q };
  const list = useQuery({ queryKey: queryKeys.memoryList(filter), queryFn: () => memoriesApi.list(filter) });
  const onSuccess = () => void qc.invalidateQueries({ queryKey: queryKeys.memories });
  const pin = useMutation({
    mutationFn: (m: MemoryView) => memoriesApi.update(m.id, { pinned: !m.pinned }),
    onSuccess,
    onError: (err) => toast.error(errorText(err)),
  });
  const remove = useMutation({
    mutationFn: (m: MemoryView) => memoriesApi.delete(m.id),
    onSuccess: () => {
      onSuccess();
      setDeleting(undefined);
      toast.success('Memory deleted');
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const items = list.data ?? [];

  return (
    <section aria-label={scope === 'shared' ? 'Shared knowledge' : 'Memory'} className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Search memories"
            placeholder="Search memories…"
            className="pl-8"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus /> Add memory
        </Button>
      </div>

      {list.isPending ? (
        <div className="h-24 animate-pulse rounded-lg border bg-muted/40" aria-busy="true" />
      ) : list.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(list.error)}
        </p>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Brain}
          title={q ? 'No matching memories' : 'No memories yet'}
          description={
            q
              ? 'Try other words.'
              : scope === 'shared'
                ? 'Facts the whole team should know. Bots add them with save_memory; you can add them here.'
                : 'Durable facts this bot keeps between runs. It saves them itself; you can add them here.'
          }
        />
      ) : (
        <ul className="space-y-2">
          {items.map((m) => (
            <li key={m.id} className="rounded-lg border bg-card p-3" aria-label={m.title}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 space-y-0.5">
                  <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                    {m.pinned && <Pin className="size-3.5 text-primary" aria-label="Pinned" />}
                    {m.title}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {m.sourceRunId ? 'Saved by the bot' : 'Added by you'} · {relativeTime(m.updatedAt)}
                    {m.tags.length > 0 && ` · ${m.tags.map((t) => `#${t}`).join(' ')}`}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={m.pinned ? `Unpin ${m.title}` : `Pin ${m.title}`}
                    onClick={() => pin.mutate(m)}
                  >
                    {m.pinned ? <PinOff /> : <Pin />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Edit ${m.title}`}
                    onClick={() => setEditing(m)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${m.title}`}
                    onClick={() => setDeleting(m)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
              <Markdown className="mt-2">{m.contentMd}</Markdown>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={editing !== undefined}
        onClose={() => setEditing(undefined)}
        title={editing === 'new' ? 'Add memory' : 'Edit memory'}
        description="Never store secrets: saves that look like keys or passwords are rejected."
      >
        {editing !== undefined && (
          <MemoryForm
            memory={editing === 'new' ? undefined : editing}
            scope={scope}
            botId={botId}
            onDone={() => {
              onSuccess();
              setEditing(undefined);
            }}
          />
        )}
      </Dialog>

      <Dialog open={deleting !== undefined} onClose={() => setDeleting(undefined)} title="Delete memory?">
        <p className="text-sm text-muted-foreground">
          “{deleting?.title}” is removed for good
          {scope === 'shared' ? ', and its file in /shared/knowledge too.' : '.'}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setDeleting(undefined)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={remove.isPending}
            onClick={() => deleting && remove.mutate(deleting)}
          >
            Delete
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

function MemoryForm({
  memory,
  scope,
  botId,
  onDone,
}: {
  memory?: MemoryView;
  scope: MemoryScope;
  botId?: string;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(memory?.title ?? '');
  const [contentMd, setContentMd] = useState(memory?.contentMd ?? '');
  const [tags, setTags] = useState(memory?.tags.join(', ') ?? '');
  const [pinned, setPinned] = useState(memory?.pinned ?? false);
  const [error, setError] = useState<string>();
  const save = useMutation({
    mutationFn: () => {
      const body = { title, contentMd, tags: parseTags(tags), pinned };
      return memory ? memoriesApi.update(memory.id, body) : memoriesApi.create({ ...body, scope, botId });
    },
    onSuccess: () => {
      toast.success(memory ? 'Memory saved' : 'Memory added');
      onDone();
    },
    onError: (err) => setError(errorText(err)),
  });

  function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!title.trim() || !contentMd.trim()) return setError('Give it a title and some content');
    setError(undefined);
    save.mutate();
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Memory">
      <Field label="Title" htmlFor="memory-title">
        <Input id="memory-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Content" htmlFor="memory-content" error={error} hint="Markdown.">
        <Textarea
          id="memory-content"
          value={contentMd}
          onChange={(e) => setContentMd(e.target.value)}
          {...invalidProps('memory-content', error)}
        />
      </Field>
      <Field label="Tags" htmlFor="memory-tags" hint="Comma-separated.">
        <Input id="memory-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
        Pin: always include it in the bot’s instructions
      </label>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={save.isPending}>
          {memory ? 'Save' : 'Add'}
        </Button>
      </div>
    </form>
  );
}
