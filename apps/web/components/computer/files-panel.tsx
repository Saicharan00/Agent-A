'use client';

import {
  type BotView,
  type FileEntry,
  type FileRoot,
  type LiveEvent,
  MAX_UPLOAD_BYTES,
} from '@agenta/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  Eye,
  EyeOff,
  File as FileIcon,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Link2,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { type DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { useShell } from '@/components/shell/shell-context';
import { Button } from '@/components/ui/button';
import { useLiveChannel } from '@/hooks/use-live-channel';
import { ApiClientError } from '@/lib/api';
import {
  ancestorsOf,
  chipLocation,
  fileKeys,
  filesApi,
  formatBytes,
  invalidateFiles,
  isDirEntry,
  isOpenableFile,
  isWithin,
  joinPath,
  parentPath,
  renamedPath,
  visibleEntries,
} from '@/lib/files';
import { readBool, STORAGE_KEYS, writeBool } from '@/lib/storage';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useFileDialogs } from './file-dialogs';
import { FileViewer } from './file-viewer';

/** Open folders re-list this often while the tab is visible: shell commands change files without any event. */
const POLL_MS = 5000;

const ROOT_LABELS: Record<FileRoot, string> = { home: 'Home', shared: 'Shared' };

type RootState = { expanded: Set<string>; cwd: string };
const initialRoots = (): Record<FileRoot, RootState> => ({
  home: { expanded: new Set(['work']), cwd: 'work' },
  shared: { expanded: new Set(), cwd: '' },
});

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong');

/** The Files tab for one bot: its home folder and the team share. Remount per bot (`key`). */
export function FilesPanel({ bot, visible }: { bot: BotView; visible: boolean }) {
  const qc = useQueryClient();
  const { theme, computerFilePath, computerFileNonce, computerBotId } = useShell();
  const [root, setRoot] = useState<FileRoot>('home');
  const [roots, setRoots] = useState(initialRoots);
  const [open, setOpen] = useState<{ root: FileRoot; path: string } | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [version, setVersion] = useState(0);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { dialog, confirm, prompt } = useFileDialogs();
  const writable = !bot.archivedAt;
  const state = roots[root];

  useEffect(() => setShowHidden(readBool(STORAGE_KEYS.filesShowHidden, false)), []);

  const patchRoot = useCallback((r: FileRoot, fn: (s: RootState) => RootState) => {
    setRoots((all) => ({ ...all, [r]: fn(all[r]) }));
  }, []);

  // A file chip in chat (openFile) lands here: switch root, unfold its folders and open it.
  const handledNonce = useRef(0);
  useEffect(() => {
    if (!computerFilePath || computerBotId !== bot.id || computerFileNonce === handledNonce.current) return;
    handledNonce.current = computerFileNonce;
    const loc = chipLocation(computerFilePath);
    if (!loc) return;
    setRoot(loc.root);
    patchRoot(loc.root, (s) => ({
      cwd: parentPath(loc.path),
      expanded: new Set([...s.expanded, ...ancestorsOf(loc.path)]),
    }));
    setOpen(loc.path ? loc : null);
  }, [computerFilePath, computerFileNonce, computerBotId, bot.id, patchRoot]);

  // Live refresh: home changes on bot:<id>, team share changes on global.
  const onEvent = useCallback(
    (event: LiveEvent) => {
      if (event.type !== 'files.changed') return;
      if (event.root === 'home' && event.botId !== bot.id) return;
      invalidateFiles(qc, event);
      setVersion((v) => v + 1);
    },
    [qc, bot.id],
  );
  useLiveChannel(`bot:${bot.id}`, { onEvent });
  useLiveChannel('global', { onEvent });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: fileKeys.root(bot.id, root) });
    setVersion((v) => v + 1);
  };

  function toggleHidden() {
    setShowHidden((v) => {
      writeBool(STORAGE_KEYS.filesShowHidden, !v);
      return !v;
    });
  }

  function toggleDir(path: string) {
    patchRoot(root, (s) => {
      const expanded = new Set(s.expanded);
      if (expanded.has(path)) expanded.delete(path);
      else expanded.add(path);
      return { expanded, cwd: path };
    });
  }

  async function upload(files: File[], dir: string) {
    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        toast.error(`${file.name} is larger than ${formatBytes(MAX_UPLOAD_BYTES)}`);
        continue;
      }
      try {
        await filesApi.upload(bot.id, root, dir, file);
      } catch (err) {
        if (!(err instanceof ApiClientError && err.code === 'already_exists')) {
          toast.error(`${file.name}: ${errorText(err)}`);
          continue;
        }
        const ok = await confirm({
          title: `Replace ${file.name}?`,
          description: `A file with that name already exists in ${dir || ROOT_LABELS[root]}.`,
          confirmLabel: 'Replace',
          destructive: true,
        });
        if (!ok) continue;
        try {
          await filesApi.upload(bot.id, root, dir, file, true);
        } catch (err2) {
          toast.error(`${file.name}: ${errorText(err2)}`);
          continue;
        }
      }
      toast.success(`Uploaded ${file.name}`);
    }
    patchRoot(root, (s) => ({
      ...s,
      expanded: new Set([...s.expanded, ...ancestorsOf(joinPath(dir, 'x'))]),
    }));
    refresh();
  }

  async function newFolder() {
    const name = await prompt({
      title: 'New folder',
      label: `Name (in ${state.cwd || ROOT_LABELS[root]})`,
      submitLabel: 'Create',
    });
    if (!name) return;
    const path = joinPath(state.cwd, name);
    try {
      await filesApi.mkdir(bot.id, root, path);
      patchRoot(root, (s) => ({ cwd: path, expanded: new Set([...s.expanded, s.cwd, path]) }));
      refresh();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  async function rename(entry: FileEntry) {
    const name = await prompt({
      title: `Rename ${entry.name}`,
      label: 'New name',
      initial: entry.name,
      submitLabel: 'Rename',
    });
    if (!name || name === entry.name) return;
    const to = joinPath(parentPath(entry.path), name);
    try {
      await filesApi.rename(bot.id, root, entry.path, to);
      patchRoot(root, (s) => ({
        cwd: renamedPath(s.cwd, entry.path, to),
        expanded: new Set([...s.expanded].map((p) => renamedPath(p, entry.path, to))),
      }));
      if (open?.root === root) setOpen({ root, path: renamedPath(open.path, entry.path, to) });
      refresh();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  async function remove(entry: FileEntry) {
    const folder = entry.type === 'dir';
    const ok = await confirm({
      title: `Delete ${entry.name}?`,
      description: folder
        ? 'This deletes the folder and everything in it. It cannot be undone.'
        : 'This deletes the file. It cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await filesApi.remove(bot.id, root, entry.path);
      toast.success(`Deleted ${entry.name}`);
      if (open?.root === root && isWithin(open.path, entry.path)) setOpen(null);
      patchRoot(root, (s) => ({ ...s, cwd: isWithin(s.cwd, entry.path) ? parentPath(entry.path) : s.cwd }));
      refresh();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  // Drag & drop: onto a folder row uploads there; anywhere else in the tree, into the current folder.
  function onDragOver(ev: DragEvent, dir: string) {
    if (!writable || !ev.dataTransfer.types.includes('Files')) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.dataTransfer.dropEffect = 'copy';
    setDropTarget(dir);
  }
  function onDrop(ev: DragEvent, dir: string) {
    if (!writable || !ev.dataTransfer.types.includes('Files')) return;
    ev.preventDefault();
    ev.stopPropagation();
    setDropTarget(null);
    const files = [...ev.dataTransfer.files];
    if (files.length) void upload(files, dir);
  }

  if (open) {
    return (
      <div className={cn('flex min-h-0 flex-1 flex-col', !visible && 'hidden')}>
        <FileViewer
          key={`${open.root}:${open.path}`}
          botId={bot.id}
          root={open.root}
          path={open.path}
          theme={theme}
          version={version}
          onBack={() => setOpen(null)}
        />
        {dialog}
      </div>
    );
  }

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', !visible && 'hidden')} data-testid="files-panel">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
        <div role="radiogroup" aria-label="Folder" className="flex rounded-md bg-muted p-0.5">
          {(['home', 'shared'] as const).map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={root === r}
              onClick={() => setRoot(r)}
              className={cn(
                'h-6 rounded px-2 text-xs text-muted-foreground',
                root === r && 'bg-background text-foreground shadow-sm',
              )}
            >
              {ROOT_LABELS[r]}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <Button variant="ghost" size="icon-sm" aria-label="Refresh" title="Refresh" onClick={refresh}>
          <RefreshCw />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={showHidden ? 'Hide noise folders' : 'Show noise folders'}
          title={showHidden ? 'Hide node_modules, .cache…' : 'Show node_modules, .cache…'}
          aria-pressed={showHidden}
          onClick={toggleHidden}
        >
          {showHidden ? <Eye /> : <EyeOff />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New folder"
          title="New folder"
          disabled={!writable}
          onClick={() => void newFolder()}
        >
          <FolderPlus />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Upload files"
          title="Upload files"
          disabled={!writable}
          onClick={() => fileInput.current?.click()}
        >
          <Upload />
        </Button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          data-testid="files-upload-input"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length) void upload(files, state.cwd);
          }}
        />
      </div>
      <p
        className="shrink-0 truncate px-3 py-1 font-mono text-[11px] text-muted-foreground"
        data-testid="files-cwd"
      >
        {root === 'home' ? '/home/bot' : '/shared'}
        {state.cwd ? `/${state.cwd}` : ''}
      </p>
      <div
        role="tree"
        aria-label={`${ROOT_LABELS[root]} files`}
        className={cn(
          'min-h-0 flex-1 overflow-auto px-1 pb-4 text-sm',
          dropTarget === '' && 'bg-accent/40 outline-2 -outline-offset-2 outline-dashed outline-primary/50',
        )}
        onDragOver={(e) => onDragOver(e, state.cwd)}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(e) => onDrop(e, state.cwd)}
      >
        <DirChildren
          botId={bot.id}
          root={root}
          path=""
          depth={0}
          visible={visible}
          showHidden={showHidden}
          expanded={state.expanded}
          cwd={state.cwd}
          dropTarget={dropTarget}
          writable={writable}
          onToggle={toggleDir}
          onOpen={(p) => {
            patchRoot(root, (s) => ({ ...s, cwd: parentPath(p) }));
            setOpen({ root, path: p });
          }}
          onRename={(e) => void rename(e)}
          onDelete={(e) => void remove(e)}
          onDragOver={onDragOver}
          onDrop={onDrop}
        />
      </div>
      {dialog}
    </div>
  );
}

type TreeProps = {
  botId: string;
  root: FileRoot;
  path: string;
  depth: number;
  visible: boolean;
  showHidden: boolean;
  expanded: Set<string>;
  cwd: string;
  dropTarget: string | null;
  writable: boolean;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  onRename: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
  onDragOver: (ev: DragEvent, dir: string) => void;
  onDrop: (ev: DragEvent, dir: string) => void;
};

/** One folder's entries, fetched when it is first expanded (lazy tree). */
function DirChildren(props: TreeProps) {
  const { botId, root, path, depth, visible, showHidden } = props;
  const listing = useQuery({
    queryKey: fileKeys.dir(botId, root, path),
    queryFn: ({ signal }) => filesApi.list(botId, root, path, signal),
    refetchInterval: visible ? POLL_MS : false,
    retry: (n, err) => !(err instanceof ApiClientError && err.status < 500) && n < 2,
  });
  const indent = { paddingLeft: `${depth * 12 + 4}px` };

  if (listing.isPending) {
    return (
      <p className="py-1 text-xs text-muted-foreground" style={indent}>
        Loading…
      </p>
    );
  }
  if (listing.isError) {
    if (depth === 0) {
      return (
        <EmptyState
          className="m-3"
          icon={FolderTree}
          title="Can't list files"
          description={errorText(listing.error)}
        />
      );
    }
    return (
      <p className="py-1 text-xs text-destructive" style={indent}>
        {errorText(listing.error)}
      </p>
    );
  }
  const entries = visibleEntries(listing.data.entries, showHidden);
  if (entries.length === 0) {
    return (
      <p className="py-1 text-xs text-muted-foreground" style={indent}>
        {depth === 0 ? 'This folder is empty. Drop files here to upload.' : 'Empty'}
      </p>
    );
  }
  return (
    <ul role="group" className="space-y-px">
      {entries.map((e) => (
        <TreeRow key={e.path} entry={e} {...props} />
      ))}
      {listing.data.omitted > 0 && (
        <li className="py-1 text-xs text-muted-foreground" style={indent}>
          …and {listing.data.omitted} more
        </li>
      )}
    </ul>
  );
}

function TreeRow({ entry, ...props }: TreeProps & { entry: FileEntry }) {
  const { depth, expanded, cwd, dropTarget, writable, onToggle, onOpen, onRename, onDelete } = props;
  const dir = isDirEntry(entry);
  const openable = isOpenableFile(entry);
  const isOpen = dir && expanded.has(entry.path);
  const Icon = dir ? (isOpen ? FolderOpen : Folder) : FileIcon;

  return (
    <li role="treeitem" aria-expanded={dir ? isOpen : undefined} aria-label={entry.name}>
      <div
        className={cn(
          'group flex h-7 items-center gap-1 rounded pr-1 hover:bg-accent/60',
          dir && cwd === entry.path && 'bg-accent/40',
          dropTarget === entry.path && 'bg-primary/15 outline-1 outline-dashed outline-primary/60',
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        onDragOver={dir ? (ev) => props.onDragOver(ev, entry.path) : undefined}
        onDrop={dir ? (ev) => props.onDrop(ev, entry.path) : undefined}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:opacity-60"
          disabled={!dir && !openable}
          onClick={() => (dir ? onToggle(entry.path) : onOpen(entry.path))}
          title={
            entry.type === 'symlink' && entry.target === null
              ? 'Link to somewhere outside this folder'
              : undefined
          }
        >
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              !dir && 'invisible',
              isOpen && 'rotate-90',
            )}
            aria-hidden
          />
          <Icon
            className={cn('size-4 shrink-0', dir ? 'text-sky-500' : 'text-muted-foreground')}
            aria-hidden
          />
          <span className={cn('truncate', entry.noise && 'text-muted-foreground')}>{entry.name}</span>
          {entry.type === 'symlink' && (
            <Link2 className="size-3 shrink-0 text-muted-foreground" aria-label="link" />
          )}
        </button>
        {openable && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums group-hover:hidden">
            {formatBytes(entry.size)}
          </span>
        )}
        {writable && (
          <span className="hidden shrink-0 items-center group-focus-within:flex group-hover:flex">
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
              aria-label={`Rename ${entry.name}`}
              onClick={() => onRename(entry)}
            >
              <Pencil className="size-3.5" />
            </button>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-background hover:text-destructive"
              aria-label={`Delete ${entry.name}`}
              onClick={() => onDelete(entry)}
            >
              <Trash2 className="size-3.5" />
            </button>
          </span>
        )}
      </div>
      {isOpen && <DirChildren {...props} path={entry.path} depth={depth + 1} />}
    </li>
  );
}
