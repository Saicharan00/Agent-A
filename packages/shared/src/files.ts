import { z } from 'zod';

// Files & shared workspace (F15): browse, view, edit, upload and download a bot's home folder and the team share.
// Paths in the API are relative to a root, POSIX style ('' is the root itself); the runner resolves them against
// the bind-mounted host folders and refuses anything that would leave the root (`..`, absolute paths, symlinks).

export const FILE_ROOTS = ['home', 'shared'] as const;
export type FileRoot = (typeof FILE_ROOTS)[number];

/** Where each root is mounted inside the bot's computer. */
export const FILE_ROOT_MOUNTS: Record<FileRoot, string> = { home: '/home/bot', shared: '/shared' };

/** Folders created in the team share on first run. */
export const SHARED_LAYOUT = ['knowledge', 'decisions', 'handoff', 'projects'] as const;

/** Folder names hidden by default in the Files tab (dependency caches and tool state). */
export const NOISE_DIRS = [
  '.cache',
  'node_modules',
  '.npm',
  '.pnpm-store',
  '__pycache__',
  '.venv',
  '.local',
  '.git',
] as const;

export function isNoiseName(name: string): boolean {
  return (NOISE_DIRS as readonly string[]).includes(name);
}

/** Text files larger than this are shown read-only and truncated. */
export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
/** Upload limit for the Files tab. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Entries returned per folder listing (the rest are counted in `omitted`). */
export const MAX_DIR_ENTRIES = 2000;

const relPath = z
  .string()
  .max(4096)
  .refine((p) => !p.includes('\0'), 'invalid path');

/** A single file or folder name: no separators, not `.` / `..`. */
export const fileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((n) => !/[/\\\0]/.test(n) && n !== '.' && n !== '..', 'not a valid name');

export const fileLocationSchema = z.object({
  root: z.enum(FILE_ROOTS),
  path: relPath.default(''),
});
export type FileLocation = z.infer<typeof fileLocationSchema>;

export const fileEntrySchema = z.object({
  name: z.string(),
  /** Relative to the root. */
  path: z.string(),
  type: z.enum(['file', 'dir', 'symlink', 'other']),
  /** For symlinks: what the link points at once resolved, when it stays inside the root. */
  target: z.enum(['file', 'dir']).nullable(),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string(),
  noise: z.boolean(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

/** GET /api/bots/:id/files?root=&path= */
export const dirListingSchema = z.object({
  root: z.enum(FILE_ROOTS),
  path: z.string(),
  entries: z.array(fileEntrySchema),
  /** Entries beyond MAX_DIR_ENTRIES that were left out. */
  omitted: z.number().int().nonnegative(),
});
export type DirListing = z.infer<typeof dirListingSchema>;

/** GET /api/bots/:id/files/content?root=&path= — text as UTF-8; binary files carry no content. */
export const fileContentSchema = z.object({
  root: z.enum(FILE_ROOTS),
  path: z.string(),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string(),
  binary: z.boolean(),
  content: z.string().nullable(),
  truncated: z.boolean(),
});
export type FileContent = z.infer<typeof fileContentSchema>;

/** PUT /api/bots/:id/files/content — `expectedModifiedAt` guards against overwriting a newer version. */
export const fileSaveRequestSchema = fileLocationSchema
  .extend({
    content: z.string().max(MAX_TEXT_FILE_BYTES),
    expectedModifiedAt: z.string().optional(),
  })
  .strict();
export type FileSaveRequest = z.input<typeof fileSaveRequestSchema>;

/** POST /api/bots/:id/files/upload?root=&path=<folder>&name=&overwrite= (raw bytes, application/octet-stream). */
const queryFlag = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

export const fileUploadQuerySchema = fileLocationSchema.extend({
  name: fileNameSchema,
  overwrite: queryFlag,
  /** The owner chose "Upload anyway" after the confidentiality guard flagged the file (F24). */
  allowFlagged: queryFlag,
});

/** POST /api/bots/:id/files/mkdir */
export const fileMkdirRequestSchema = fileLocationSchema.strict();
/** POST /api/bots/:id/files/rename — `to` is the new path relative to the same root. */
export const fileRenameRequestSchema = z
  .object({ root: z.enum(FILE_ROOTS), from: relPath, to: relPath })
  .strict();
export type FileRenameRequest = z.input<typeof fileRenameRequestSchema>;

/** Result of upload / mkdir / rename / save: the entry as it is now. */
export const fileMutationResponseSchema = z.object({ entry: fileEntrySchema });
export type FileMutationResponse = z.infer<typeof fileMutationResponseSchema>;

/**
 * Something changed under a root: published on `bot:<id>` (home, or shared as seen by that bot) and, for the team
 * share, on `global`. From the Files API and from engine `file.changed` events.
 */
export const liveFilesChangedSchema = z.object({
  type: z.literal('files.changed'),
  botId: z.string().nullable(),
  root: z.enum(FILE_ROOTS),
  path: z.string(),
  change: z.enum(['created', 'modified', 'deleted', 'renamed']),
});
export type LiveFilesChanged = z.infer<typeof liveFilesChangedSchema>;

/**
 * Maps a path as the bot sees it (`/home/bot/work/a.txt`, `/shared/x`, or relative to the work folder) to a root
 * and a relative path. Null for paths outside both roots.
 */
export function locateContainerPath(p: string): FileLocation | null {
  const raw = p.trim();
  if (!raw) return null;
  const abs = raw.startsWith('/') ? raw : `${FILE_ROOT_MOUNTS.home}/work/${raw}`;
  const parts: string[] = [];
  for (const seg of abs.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.pop()) return null;
    } else parts.push(seg);
  }
  const norm = `/${parts.join('/')}`;
  for (const root of FILE_ROOTS) {
    const mount = FILE_ROOT_MOUNTS[root];
    if (norm === mount) return { root, path: '' };
    if (norm.startsWith(`${mount}/`)) return { root, path: norm.slice(mount.length + 1) };
  }
  return null;
}

/** The inverse of locateContainerPath. */
export function containerPath(root: FileRoot, path: string): string {
  return path ? `${FILE_ROOT_MOUNTS[root]}/${path}` : FILE_ROOT_MOUNTS[root];
}

/** POST /api/bots/:id/computer/screenshot (F16): the desktop saved as a PNG in the bot's home. */
export const SCREENSHOTS_DIR = 'screenshots';
export const desktopScreenshotSchema = z.object({ root: z.literal('home'), path: z.string() });
export type DesktopScreenshot = z.infer<typeof desktopScreenshotSchema>;
