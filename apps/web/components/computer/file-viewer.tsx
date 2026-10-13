'use client';

import { type FileRoot, containerPath } from '@agenta/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Code, Download, Eye, FileWarning, Pencil, RotateCcw, Save } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { Markdown } from '@/components/markdown';
import { Button, buttonVariants } from '@/components/ui/button';
import { ApiClientError } from '@/lib/api';
import {
  baseName,
  fileKeys,
  filesApi,
  formatBytes,
  monacoLanguage,
  rawFileUrl,
  viewerKind,
} from '@/lib/files';
import { toast } from '@/lib/toast';

const CodeEditor = dynamic(() => import('./code-editor'), {
  ssr: false,
  loading: () => <p className="p-4 text-sm text-muted-foreground">Loading editor…</p>,
});

/**
 * One open file: Monaco (read-only until "Edit"), markdown preview, image preview, PDF in the browser's viewer,
 * download. Saving sends the version it was opened at, so a bot's newer write is never silently overwritten.
 */
export function FileViewer({
  botId,
  root,
  path,
  theme,
  version,
  onBack,
}: {
  botId: string;
  root: FileRoot;
  path: string;
  theme: 'light' | 'dark';
  /** Bumped when this root changed on disk: previews reload. */
  version: number;
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const kind = viewerKind(path);
  const textual = kind === 'text' || kind === 'markdown';
  const content = useQuery({
    queryKey: fileKeys.content(botId, root, path),
    queryFn: ({ signal }) => filesApi.content(botId, root, path, signal),
    enabled: textual,
    retry: (n, err) => !(err instanceof ApiClientError && err.status < 500) && n < 2,
  });
  const [mdSource, setMdSource] = useState(false);
  // Editing: the draft and the version it started from. Live refreshes never touch the draft.
  const [draft, setDraft] = useState<string | null>(null);
  const [base, setBase] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const data = content.data;
  const editing = draft !== null;
  const dirty = editing && data !== undefined && draft !== data.content;
  const editable = textual && data !== undefined && !data.binary && !data.truncated;

  function startEdit() {
    if (!data || data.content === null) return;
    setDraft(data.content);
    setBase(data.modifiedAt);
    setConflict(false);
    setMdSource(true);
  }

  function stopEdit() {
    if (dirty && !window.confirm('Discard your unsaved changes?')) return;
    setDraft(null);
    setConflict(false);
  }

  async function save() {
    if (draft === null || saving) return;
    setSaving(true);
    try {
      const { entry } = await filesApi.save(botId, root, path, draft, base);
      setBase(entry.modifiedAt);
      setConflict(false);
      // The saved text is what's on disk now.
      if (data) qc.setQueryData(fileKeys.content(botId, root, path), { ...data, content: draft, ...entry });
      toast.success(`Saved ${baseName(path)}`);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'modified_elsewhere') setConflict(true);
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function reloadFromDisk() {
    setDraft(null);
    setConflict(false);
    await content.refetch();
  }

  function back() {
    if (dirty && !window.confirm('Discard your unsaved changes?')) return;
    onBack();
  }

  const raw = rawFileUrl(botId, root, path);
  const preview = `${raw}&v=${version}`;

  let body;
  if (kind === 'image') {
    body = (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/30 p-4">
        {/* eslint-disable-next-line @next/next/no-img-element -- bytes from the runner, not a static asset */}
        <img src={preview} alt={baseName(path)} className="max-h-full max-w-full object-contain" />
      </div>
    );
  } else if (kind === 'pdf') {
    body = (
      <iframe src={preview} title={baseName(path)} className="min-h-0 w-full flex-1 border-0 bg-white" />
    );
  } else if (content.isPending) {
    body = <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  } else if (content.isError || !data) {
    body = (
      <EmptyState
        className="m-4"
        icon={FileWarning}
        title="Can't open this file"
        description={content.error instanceof Error ? content.error.message : 'It may have been deleted.'}
      />
    );
  } else if (data.binary) {
    body = (
      <EmptyState
        className="m-4"
        icon={FileWarning}
        title="Binary file"
        description={`${formatBytes(data.size)}. It can't be shown here; download it instead.`}
        action={
          <a
            href={rawFileUrl(botId, root, path, true)}
            download
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <Download /> Download
          </a>
        }
      />
    );
  } else if (kind === 'markdown' && !mdSource && !editing) {
    body = (
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3" data-testid="markdown-preview">
        <Markdown>{data.content ?? ''}</Markdown>
      </div>
    );
  } else {
    body = (
      <div className="min-h-0 flex-1">
        <CodeEditor
          path={`${root}:${path}`}
          value={editing ? draft : (data.content ?? '')}
          language={monacoLanguage(path)}
          theme={theme}
          readOnly={!editing}
          // Monaco also reports programmatic value changes (e.g. after Reload): never revive a closed draft.
          onChange={editing ? (v) => setDraft((d) => (d === null ? d : v)) : undefined}
          onSave={editing ? () => void save() : undefined}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-viewer">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
        <Button variant="ghost" size="icon-sm" onClick={back} aria-label="Back to files">
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {baseName(path)}
            {dirty && <span className="text-muted-foreground"> •</span>}
          </p>
          <p
            className="truncate font-mono text-[11px] text-muted-foreground"
            data-testid="computer-file-path"
          >
            {containerPath(root, path)}
          </p>
        </div>
        {kind === 'markdown' && !editing && data && !data.binary && (
          <Button variant="ghost" size="sm" onClick={() => setMdSource((s) => !s)}>
            {mdSource ? <Eye /> : <Code />} {mdSource ? 'Preview' : 'Source'}
          </Button>
        )}
        {editable && !editing && (
          <Button variant="ghost" size="sm" onClick={startEdit}>
            <Pencil /> Edit
          </Button>
        )}
        {editing && (
          <>
            <Button variant="ghost" size="sm" onClick={stopEdit}>
              Done
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
              <Save /> {saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        )}
        <a
          href={rawFileUrl(botId, root, path, true)}
          download
          aria-label="Download"
          title="Download"
          className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
        >
          <Download />
        </a>
      </div>
      {conflict && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
        >
          <span className="flex-1">
            This file changed on disk since you opened it. Saving would overwrite that.
          </span>
          <Button variant="outline" size="sm" onClick={() => void reloadFromDisk()}>
            <RotateCcw /> Reload
          </Button>
        </div>
      )}
      {data?.truncated && (
        <p className="shrink-0 border-b px-3 py-1.5 text-xs text-muted-foreground">
          Large file: showing the first {formatBytes(data.content?.length ?? 0)} of {formatBytes(data.size)},
          read-only.
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
    </div>
  );
}
