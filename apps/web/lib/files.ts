// Files tab logic (F15): API calls, query keys, and the pure helpers the file tree and viewer use.
import {
  type FileEntry,
  type FileRoot,
  type LiveFilesChanged,
  dirListingSchema,
  fileContentSchema,
  fileMutationResponseSchema,
  locateContainerPath,
} from '@agenta/shared';
import type { QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiRequest, buildApiUrl } from './api';

const enc = encodeURIComponent;

export const filesApi = {
  list: (botId: string, root: FileRoot, path: string, signal?: AbortSignal) =>
    apiRequest(`/bots/${enc(botId)}/files`, dirListingSchema, { query: { root, path }, signal }),
  content: (botId: string, root: FileRoot, path: string, signal?: AbortSignal) =>
    apiRequest(`/bots/${enc(botId)}/files/content`, fileContentSchema, { query: { root, path }, signal }),
  save: (botId: string, root: FileRoot, path: string, content: string, expectedModifiedAt?: string) =>
    apiRequest(`/bots/${enc(botId)}/files/content`, fileMutationResponseSchema, {
      method: 'PUT',
      body: { root, path, content, expectedModifiedAt },
    }),
  upload: (botId: string, root: FileRoot, dir: string, file: File, overwrite = false, allowFlagged = false) =>
    apiRequest(`/bots/${enc(botId)}/files/upload`, fileMutationResponseSchema, {
      method: 'POST',
      raw: file,
      query: {
        root,
        path: dir,
        name: file.name,
        overwrite: overwrite ? 'true' : undefined,
        allowFlagged: allowFlagged ? 'true' : undefined,
      },
    }),
  mkdir: (botId: string, root: FileRoot, path: string) =>
    apiRequest(`/bots/${enc(botId)}/files/mkdir`, fileMutationResponseSchema, {
      method: 'POST',
      body: { root, path },
    }),
  rename: (botId: string, root: FileRoot, from: string, to: string) =>
    apiRequest(`/bots/${enc(botId)}/files/rename`, fileMutationResponseSchema, {
      method: 'POST',
      body: { root, from, to },
    }),
  remove: (botId: string, root: FileRoot, path: string) =>
    apiRequest(`/bots/${enc(botId)}/files`, z.unknown(), { method: 'DELETE', query: { root, path } }),
};

/** URL of a file's bytes: inline preview (images, PDFs) or a download. */
export function rawFileUrl(botId: string, root: FileRoot, path: string, download = false): string {
  return buildApiUrl(`/bots/${enc(botId)}/files/raw`, { root, path, download: download ? 1 : undefined });
}

export const fileKeys = {
  /** Everything cached for one root as seen by one bot. */
  root: (botId: string, root: FileRoot) => ['files', botId, root] as const,
  dir: (botId: string, root: FileRoot, path: string) => ['files', botId, root, 'dir', path] as const,
  content: (botId: string, root: FileRoot, path: string) => ['files', botId, root, 'content', path] as const,
};

/**
 * Refreshes cached listings and contents after a change. Team share changes affect every bot's view of /shared.
 * Open editors protect unsaved edits themselves (the draft lives in component state).
 */
export function invalidateFiles(qc: QueryClient, event: Pick<LiveFilesChanged, 'botId' | 'root'>): void {
  if (event.root === 'shared') {
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'files' && q.queryKey[2] === 'shared' });
  } else if (event.botId) {
    void qc.invalidateQueries({ queryKey: fileKeys.root(event.botId, 'home') });
  }
}

// ---------- paths (relative to a root, '/'-separated, '' = the root) ----------

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Folders to expand so `path` is visible: 'a/b/c.txt' → ['a', 'a/b']. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** Is `path` the folder `dir` or inside it? */
export function isWithin(path: string, dir: string): boolean {
  return dir === '' || path === dir || path.startsWith(`${dir}/`);
}

/** After renaming `from` → `to`, where does `path` live now? */
export function renamedPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
}

/** A chat file chip's path (as the bot saw it) → where the Files tab should open, or null if outside the roots. */
export function chipLocation(containerPath: string): { root: FileRoot; path: string } | null {
  return locateContainerPath(containerPath);
}

export function isDirEntry(e: Pick<FileEntry, 'type' | 'target'>): boolean {
  return e.type === 'dir' || (e.type === 'symlink' && e.target === 'dir');
}

export function isOpenableFile(e: Pick<FileEntry, 'type' | 'target'>): boolean {
  return e.type === 'file' || (e.type === 'symlink' && e.target === 'file');
}

/** Visible entries: noise folders (node_modules, .cache, …) only when `showHidden` is on. */
export function visibleEntries<E extends Pick<FileEntry, 'noise'>>(entries: E[], showHidden: boolean): E[] {
  return showHidden ? entries : entries.filter((e) => !e.noise);
}

// ---------- viewer ----------

export type ViewerKind = 'image' | 'pdf' | 'markdown' | 'text';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);

function extOf(name: string): string {
  const base = baseName(name).toLowerCase();
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i + 1);
}

/** How the viewer shows a file (text files may still turn out binary once loaded). */
export function viewerKind(name: string): ViewerKind {
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
  return 'text';
}

const LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonl: 'json',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  xml: 'xml',
  svg: 'xml',
  sql: 'sql',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  dockerfile: 'dockerfile',
};

/** Monaco language id for a file name (plaintext when unknown). */
export function monacoLanguage(name: string): string {
  const base = baseName(name).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'plaintext';
  return LANGUAGES[extOf(name)] ?? 'plaintext';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}
