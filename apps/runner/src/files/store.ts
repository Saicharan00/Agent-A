import {
  closeSync,
  type Dirent,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import {
  type DirListing,
  type FileContent,
  type FileEntry,
  type FileRoot,
  isNoiseName,
  MAX_DIR_ENTRIES,
  MAX_TEXT_FILE_BYTES,
} from '@agenta/shared';

export class FilesError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'FilesError';
  }
}

const ERRNO: Record<string, [string, number, string]> = {
  ENOENT: ['not_found', 404, 'No such file or folder'],
  ENOTDIR: ['not_a_folder', 400, 'Not a folder'],
  EISDIR: ['is_a_folder', 400, 'That is a folder'],
  EEXIST: ['already_exists', 409, 'Something with that name already exists'],
  ENOTEMPTY: ['already_exists', 409, 'Something with that name already exists'],
  EACCES: ['permission_denied', 403, 'Permission denied'],
  EPERM: ['permission_denied', 403, 'Permission denied'],
  EINVAL: ['invalid_path', 400, 'Invalid path'],
  ENAMETOOLONG: ['invalid_path', 400, 'Path is too long'],
};

/** Turns filesystem errors into FilesErrors (other errors pass through). */
export function fsError(err: unknown): unknown {
  if (err instanceof FilesError) return err;
  const mapped = ERRNO[(err as NodeJS.ErrnoException)?.code ?? ''];
  return mapped ? new FilesError(mapped[0], mapped[2], mapped[1]) : err;
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw fsError(err);
  }
}

const outside = () => new FilesError('outside_root', 'That path is outside the folder', 403);

/**
 * Splits a root-relative path into segments. Refuses absolute paths and `..` outright (rather than normalising
 * them away), so a client can never name something outside the root even by accident.
 */
export function splitRelPath(path: string): string[] {
  if (path.includes('\0')) throw new FilesError('invalid_path', 'Invalid path', 400);
  if (path.startsWith('/') || path.startsWith('\\')) throw outside();
  const segs = path.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.includes('..')) throw outside();
  return segs;
}

function modifiedAt(st: Stats): string {
  return st.mtime.toISOString();
}

/** First bytes that decide whether a file is shown as text. */
const SNIFF_BYTES = 8192;

function looksBinary(buf: Buffer, complete: boolean): boolean {
  if (buf.subarray(0, SNIFF_BYTES).includes(0)) return true;
  // A truncated read can end mid-character: only the complete prefix must be valid UTF-8.
  const check = complete ? buf : buf.subarray(0, Math.max(0, buf.length - 4));
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(check);
    return false;
  } catch {
    return true;
  }
}

/**
 * One root folder (a bot's home or the team share) on the runner's disk. Every operation resolves its path with
 * realpath and checks it stays under the root's realpath, so `..`, absolute paths and symlinks pointing elsewhere
 * (including symlinked parent folders) are refused. Links themselves can still be listed, renamed and deleted.
 * Single-user tool: a symlink swapped in between the check and the use (TOCTOU) is out of scope.
 */
export class FileStore {
  private readonly rootReal: string;

  constructor(
    readonly root: FileRoot,
    rootDir: string,
  ) {
    mkdirSync(rootDir, { recursive: true });
    this.rootReal = realpathSync(rootDir);
  }

  private inside(real: string): boolean {
    return real === this.rootReal || real.startsWith(this.rootReal + sep);
  }

  /** The host path of `rel`, without following its last component (its parent folder is checked). */
  private locate(rel: string): { abs: string; segs: string[] } {
    const segs = splitRelPath(rel);
    if (segs.length === 0) return { abs: this.rootReal, segs };
    const parent = wrap(() => realpathSync(join(this.rootReal, ...segs.slice(0, -1))));
    if (!this.inside(parent)) throw outside();
    return { abs: join(parent, segs.at(-1)!), segs };
  }

  /** The real host path of an existing `rel`, following symlinks; refused when it resolves outside the root. */
  private resolveExisting(rel: string): string {
    const { abs } = this.locate(rel);
    const real = wrap(() => realpathSync(abs));
    if (!this.inside(real)) throw outside();
    return real;
  }

  private relOf(segs: string[]): string {
    return segs.join('/');
  }

  private entry(abs: string, rel: string, name: string, dirent?: Dirent): FileEntry {
    const st = lstatSync(abs);
    let type: FileEntry['type'] = 'other';
    let target: FileEntry['target'] = null;
    let size = st.size;
    const isLink = dirent ? dirent.isSymbolicLink() : st.isSymbolicLink();
    if (isLink) {
      type = 'symlink';
      try {
        const real = realpathSync(abs);
        if (this.inside(real)) {
          const tst = statSync(real);
          target = tst.isDirectory() ? 'dir' : tst.isFile() ? 'file' : null;
          size = tst.isFile() ? tst.size : 0;
        }
      } catch {
        // Dangling link: shown, but cannot be opened.
      }
    } else if (st.isDirectory()) {
      type = 'dir';
      size = 0;
    } else if (st.isFile()) type = 'file';
    return { name, path: rel, type, target, size, modifiedAt: modifiedAt(st), noise: isNoiseName(name) };
  }

  /** Describes one entry (the link itself for symlinks). */
  stat(rel: string): FileEntry {
    const { abs, segs } = this.locate(rel);
    return wrap(() => this.entry(abs, this.relOf(segs), segs.at(-1) ?? ''));
  }

  list(rel: string): DirListing {
    const real = this.resolveExisting(rel);
    const segs = splitRelPath(rel);
    return wrap(() => {
      if (!statSync(real).isDirectory()) throw new FilesError('not_a_folder', 'Not a folder', 400);
      const dirents = readdirSync(real, { withFileTypes: true });
      const entries: FileEntry[] = [];
      for (const d of dirents) {
        try {
          entries.push(this.entry(join(real, d.name), this.relOf([...segs, d.name]), d.name, d));
        } catch {
          // Vanished between readdir and lstat (a bot deleting files right now): skip it.
        }
      }
      const isDir = (e: FileEntry) => e.type === 'dir' || (e.type === 'symlink' && e.target === 'dir');
      entries.sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name));
      return {
        root: this.root,
        path: this.relOf(segs),
        entries: entries.slice(0, MAX_DIR_ENTRIES),
        omitted: Math.max(0, entries.length - MAX_DIR_ENTRIES),
      };
    });
  }

  read(rel: string): FileContent {
    const real = this.resolveExisting(rel);
    return wrap(() => {
      const st = statSync(real);
      if (st.isDirectory()) throw new FilesError('is_a_folder', 'That is a folder', 400);
      if (!st.isFile()) throw new FilesError('not_a_file', 'Not a regular file', 400);
      const want = Math.min(st.size, MAX_TEXT_FILE_BYTES);
      const buf = Buffer.alloc(want);
      const fd = openSync(real, 'r');
      let got = 0;
      try {
        while (got < want) {
          const n = readSync(fd, buf, got, want - got, got);
          if (n === 0) break;
          got += n;
        }
      } finally {
        closeSync(fd);
      }
      const data = buf.subarray(0, got);
      const truncated = st.size > got;
      const binary = looksBinary(data, !truncated);
      return {
        root: this.root,
        path: this.relOf(splitRelPath(rel)),
        size: st.size,
        modifiedAt: modifiedAt(st),
        binary,
        content: binary ? null : new TextDecoder('utf-8').decode(data),
        truncated,
      };
    });
  }

  /** Real path and size of a file for streaming downloads. */
  rawFile(rel: string): { real: string; size: number; name: string } {
    const real = this.resolveExisting(rel);
    const st = wrap(() => statSync(real));
    if (!st.isFile()) throw new FilesError('not_a_file', 'Not a regular file', 400);
    return { real, size: st.size, name: basename(real) };
  }

  /** Where a write to `rel` lands: through a symlink only if it resolves inside the root. */
  private writeTarget(rel: string): { target: string; exists: boolean } {
    const { abs, segs } = this.locate(rel);
    if (segs.length === 0) throw new FilesError('invalid_path', 'Pick a file name', 400);
    let st: Stats;
    try {
      st = lstatSync(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // A new name in a checked parent (a dangling link would have lstat'ed fine and is refused below).
        return { target: abs, exists: false };
      }
      throw fsError(err);
    }
    const target = st.isSymbolicLink() ? this.resolveExisting(rel) : abs;
    if (wrap(() => statSync(target)).isDirectory())
      throw new FilesError('is_a_folder', 'That is a folder', 400);
    return { target, exists: true };
  }

  /** Writes a text file. With `expectedModifiedAt`, refuses (409) when the file changed since it was read. */
  writeText(rel: string, content: string, expectedModifiedAt?: string): FileEntry {
    const { target, exists } = this.writeTarget(rel);
    if (expectedModifiedAt && exists) {
      const now = modifiedAt(wrap(() => statSync(target)));
      if (now !== expectedModifiedAt) {
        throw new FilesError(
          'modified_elsewhere',
          'The file changed since you opened it. Reload it first.',
          409,
        );
      }
    }
    wrap(() => writeFileSync(target, content));
    return this.stat(rel);
  }

  /** Writes uploaded bytes. Without `overwrite`, an existing name is refused (409). */
  writeBytes(rel: string, data: Buffer, overwrite: boolean): FileEntry {
    const { target, exists } = this.writeTarget(rel);
    if (exists && !overwrite) throw new FilesError('already_exists', `${basename(rel)} already exists`, 409);
    wrap(() => writeFileSync(target, data, overwrite ? undefined : { flag: 'wx' }));
    return this.stat(rel);
  }

  mkdir(rel: string): FileEntry {
    const { abs, segs } = this.locate(rel);
    if (segs.length === 0) throw new FilesError('invalid_path', 'Pick a folder name', 400);
    wrap(() => mkdirSync(abs));
    return this.stat(rel);
  }

  rename(from: string, to: string): FileEntry {
    const src = this.locate(from);
    const dst = this.locate(to);
    if (src.segs.length === 0 || dst.segs.length === 0) {
      throw new FilesError('invalid_path', 'The root folder cannot be renamed', 400);
    }
    wrap(() => lstatSync(src.abs));
    let taken = true;
    try {
      lstatSync(dst.abs);
    } catch {
      taken = false;
    }
    if (taken) throw new FilesError('already_exists', `${basename(to)} already exists`, 409);
    if (dst.abs.startsWith(src.abs + sep)) {
      throw new FilesError('invalid_path', 'A folder cannot be moved into itself', 400);
    }
    wrap(() => renameSync(src.abs, dst.abs));
    return this.stat(to);
  }

  /** Deletes a file, a link (not its target) or a folder with everything in it. */
  remove(rel: string): void {
    const { abs, segs } = this.locate(rel);
    if (segs.length === 0) throw new FilesError('invalid_path', 'The root folder cannot be deleted', 400);
    const st = wrap(() => lstatSync(abs));
    // rm never follows symlinks inside the folder it deletes.
    wrap(() => (st.isDirectory() ? rmSync(abs, { recursive: true }) : unlinkSync(abs)));
  }

  /** Parent folder of a relative path ('' for top-level entries). */
  static parentOf(rel: string): string {
    const d = dirname(splitRelPath(rel).join('/'));
    return d === '.' ? '' : d;
  }
}
