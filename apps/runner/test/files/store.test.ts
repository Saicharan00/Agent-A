import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore, FilesError, splitRelPath } from '../../src/files/store';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof FilesError) return err.code;
    throw err;
  }
  return undefined;
}

describe('splitRelPath', () => {
  it('splits relative paths and drops empty and `.` segments', () => {
    expect(splitRelPath('')).toEqual([]);
    expect(splitRelPath('work//a/./b.txt')).toEqual(['work', 'a', 'b.txt']);
    expect(splitRelPath('work/')).toEqual(['work']);
  });

  it('refuses `..`, absolute paths and NUL bytes', () => {
    expect(code(() => splitRelPath('../etc/passwd'))).toBe('outside_root');
    expect(code(() => splitRelPath('work/../../x'))).toBe('outside_root');
    expect(code(() => splitRelPath('work/..'))).toBe('outside_root');
    expect(code(() => splitRelPath('/etc/passwd'))).toBe('outside_root');
    expect(code(() => splitRelPath('\\etc'))).toBe('outside_root');
    expect(code(() => splitRelPath('a\0b'))).toBe('invalid_path');
  });
});

describe('FileStore', () => {
  let dir: string;
  let root: string;
  let outside: string;
  let store: FileStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenta-files-'));
    root = join(dir, 'home');
    outside = join(dir, 'secret');
    mkdirSync(join(root, 'work'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, 'key.txt'), 'top secret');
    writeFileSync(join(dir, 'home-evil.txt'), 'sibling');
    writeFileSync(join(root, 'work', 'a.txt'), 'hello\n');
    store = new FileStore('home', root);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists folders first, then files by name, flags noise folders and symlinks', () => {
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'b.md'), '# b');
    symlinkSync('work', join(root, 'link-to-work'));
    symlinkSync(outside, join(root, 'escape'));
    symlinkSync('nowhere', join(root, 'dangling'));
    const listing = store.list('');
    expect(listing.path).toBe('');
    expect(listing.entries.map((e) => e.name)).toEqual([
      'link-to-work',
      'node_modules',
      'work',
      'b.md',
      'dangling',
      'escape',
    ]);
    const by = Object.fromEntries(listing.entries.map((e) => [e.name, e]));
    expect(by['node_modules']).toMatchObject({ type: 'dir', noise: true });
    expect(by['link-to-work']).toMatchObject({ type: 'symlink', target: 'dir', path: 'link-to-work' });
    // Links that leave the root are shown but never resolved.
    expect(by['escape']).toMatchObject({ type: 'symlink', target: null });
    expect(by['dangling']).toMatchObject({ type: 'symlink', target: null });
    expect(store.list('work').entries).toEqual([
      expect.objectContaining({ name: 'a.txt', path: 'work/a.txt', type: 'file', size: 6, noise: false }),
    ]);
  });

  it('refuses ../ and absolute paths for every operation', () => {
    for (const p of ['..', '../secret', 'work/../../secret/key.txt', '/etc/passwd', `${outside}/key.txt`]) {
      expect(code(() => store.list(p))).toBe('outside_root');
      expect(code(() => store.read(p))).toBe('outside_root');
      expect(code(() => store.rawFile(p))).toBe('outside_root');
      expect(code(() => store.writeText(p, 'x'))).toBe('outside_root');
      expect(code(() => store.writeBytes(p, Buffer.from('x'), true))).toBe('outside_root');
      expect(code(() => store.mkdir(p))).toBe('outside_root');
      expect(code(() => store.remove(p))).toBe('outside_root');
      expect(code(() => store.rename('work/a.txt', p))).toBe('outside_root');
      expect(code(() => store.rename(p, 'work/x'))).toBe('outside_root');
    }
    // A sibling folder whose name starts with the root's name is not inside it.
    expect(code(() => store.read('../home-evil.txt'))).toBe('outside_root');
    expect(readFileSync(join(outside, 'key.txt'), 'utf8')).toBe('top secret');
  });

  it('never follows symlinks out of the root (file, folder or parent folder)', () => {
    symlinkSync(join(outside, 'key.txt'), join(root, 'key-link'));
    symlinkSync(outside, join(root, 'work', 'out'));
    expect(code(() => store.read('key-link'))).toBe('outside_root');
    expect(code(() => store.rawFile('key-link'))).toBe('outside_root');
    expect(code(() => store.writeText('key-link', 'pwned'))).toBe('outside_root');
    expect(code(() => store.writeBytes('key-link', Buffer.from('pwned'), true))).toBe('outside_root');
    expect(code(() => store.list('work/out'))).toBe('outside_root');
    // Through a symlinked parent folder.
    expect(code(() => store.read('work/out/key.txt'))).toBe('outside_root');
    expect(code(() => store.writeText('work/out/new.txt', 'x'))).toBe('outside_root');
    expect(code(() => store.mkdir('work/out/sub'))).toBe('outside_root');
    expect(code(() => store.remove('work/out/key.txt'))).toBe('outside_root');
    expect(readFileSync(join(outside, 'key.txt'), 'utf8')).toBe('top secret');

    // The links themselves can still be removed, which leaves their targets alone.
    store.remove('key-link');
    store.remove('work/out');
    expect(readFileSync(join(outside, 'key.txt'), 'utf8')).toBe('top secret');
  });

  it('follows symlinks that stay inside the root', () => {
    symlinkSync('work/a.txt', join(root, 'alias.txt'));
    expect(store.read('alias.txt').content).toBe('hello\n');
    store.writeText('alias.txt', 'via link\n');
    expect(readFileSync(join(root, 'work', 'a.txt'), 'utf8')).toBe('via link\n');
  });

  it('reads text, detects binary files and truncates big files', () => {
    expect(store.read('work/a.txt')).toMatchObject({
      path: 'work/a.txt',
      binary: false,
      content: 'hello\n',
      truncated: false,
      size: 6,
    });
    writeFileSync(join(root, 'img.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    expect(store.read('img.bin')).toMatchObject({ binary: true, content: null });
    writeFileSync(join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect(store.read('latin1.txt').binary).toBe(true);
    writeFileSync(join(root, 'big.log'), 'x'.repeat(3 * 1024 * 1024));
    const big = store.read('big.log');
    expect(big).toMatchObject({ binary: false, truncated: true, size: 3 * 1024 * 1024 });
    expect(big.content).toHaveLength(2 * 1024 * 1024);
    expect(code(() => store.read('work'))).toBe('is_a_folder');
    expect(code(() => store.read('missing.txt'))).toBe('not_found');
  });

  it('saves text and refuses to overwrite a file changed since it was read', () => {
    const before = store.read('work/a.txt');
    const saved = store.writeText('work/a.txt', 'edited\n', before.modifiedAt);
    expect(readFileSync(join(root, 'work', 'a.txt'), 'utf8')).toBe('edited\n');
    expect(saved).toMatchObject({ path: 'work/a.txt', size: 7 });
    utimesSync(join(root, 'work', 'a.txt'), new Date(), new Date(Date.now() + 5000));
    expect(code(() => store.writeText('work/a.txt', 'stale', before.modifiedAt))).toBe('modified_elsewhere');
    expect(store.writeText('work/new.md', '# new').path).toBe('work/new.md');
    expect(code(() => store.writeText('work', 'x'))).toBe('is_a_folder');
    expect(code(() => store.writeText('', 'x'))).toBe('invalid_path');
  });

  it('uploads without overwriting unless asked', () => {
    store.writeBytes('work/up.bin', Buffer.from([1, 2, 3]), false);
    expect(code(() => store.writeBytes('work/up.bin', Buffer.from([4]), false))).toBe('already_exists');
    store.writeBytes('work/up.bin', Buffer.from([4]), true);
    expect([...readFileSync(join(root, 'work', 'up.bin'))]).toEqual([4]);
    expect(code(() => store.writeBytes('missing/up.bin', Buffer.from([1]), false))).toBe('not_found');
  });

  it('creates folders, renames and deletes, but never the root', () => {
    expect(store.mkdir('work/sub')).toMatchObject({ type: 'dir', path: 'work/sub' });
    expect(code(() => store.mkdir('work/sub'))).toBe('already_exists');
    expect(store.rename('work/a.txt', 'work/sub/b.txt')).toMatchObject({ path: 'work/sub/b.txt' });
    writeFileSync(join(root, 'work', 'c.txt'), 'c');
    expect(code(() => store.rename('work/c.txt', 'work/sub/b.txt'))).toBe('already_exists');
    expect(code(() => store.rename('work', 'work/sub/inner'))).toBe('invalid_path');
    expect(code(() => store.rename('', 'x'))).toBe('invalid_path');
    store.remove('work/sub');
    expect(store.list('work').entries.map((e) => e.name)).toEqual(['c.txt']);
    expect(code(() => store.remove(''))).toBe('invalid_path');
    expect(code(() => store.remove('.'))).toBe('invalid_path');
    expect(code(() => store.remove('work/missing'))).toBe('not_found');
  });

  it('parentOf gives the containing folder', () => {
    expect(FileStore.parentOf('a.txt')).toBe('');
    expect(FileStore.parentOf('work/sub/a.txt')).toBe('work/sub');
  });
});
