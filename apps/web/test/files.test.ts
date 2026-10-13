import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import {
  ancestorsOf,
  baseName,
  chipLocation,
  fileKeys,
  formatBytes,
  invalidateFiles,
  isWithin,
  joinPath,
  monacoLanguage,
  parentPath,
  rawFileUrl,
  renamedPath,
  viewerKind,
  visibleEntries,
} from '@/lib/files';

describe('file paths', () => {
  it('joins, splits and walks relative paths', () => {
    expect(joinPath('', 'a.txt')).toBe('a.txt');
    expect(joinPath('work', 'a.txt')).toBe('work/a.txt');
    expect(parentPath('work/sub/a.txt')).toBe('work/sub');
    expect(parentPath('a.txt')).toBe('');
    expect(baseName('work/sub/a.txt')).toBe('a.txt');
    expect(ancestorsOf('work/sub/a.txt')).toEqual(['work', 'work/sub']);
    expect(ancestorsOf('a.txt')).toEqual([]);
  });

  it('tracks paths through renames and containment', () => {
    expect(isWithin('work/a', 'work')).toBe(true);
    expect(isWithin('workshop/a', 'work')).toBe(false);
    expect(isWithin('anything', '')).toBe(true);
    expect(renamedPath('work/a/b.txt', 'work/a', 'work/z')).toBe('work/z/b.txt');
    expect(renamedPath('work/a', 'work/a', 'work/z')).toBe('work/z');
    expect(renamedPath('work/ab', 'work/a', 'work/z')).toBe('work/ab');
  });

  it('maps chat file chips to the Files tab', () => {
    expect(chipLocation('/home/bot/work/hello.txt')).toEqual({ root: 'home', path: 'work/hello.txt' });
    expect(chipLocation('/shared/knowledge/a.md')).toEqual({ root: 'shared', path: 'knowledge/a.md' });
    expect(chipLocation('/etc/hosts')).toBeNull();
  });

  it('builds raw URLs on the web origin', () => {
    expect(rawFileUrl('bot_1', 'home', 'work/a b.png')).toBe(
      '/api/bots/bot_1/files/raw?root=home&path=work%2Fa+b.png',
    );
    expect(rawFileUrl('bot_1', 'shared', 'x.pdf', true)).toBe(
      '/api/bots/bot_1/files/raw?root=shared&path=x.pdf&download=1',
    );
  });
});

describe('viewer helpers', () => {
  it('picks a viewer and an editor language by extension', () => {
    expect(viewerKind('a/photo.PNG')).toBe('image');
    expect(viewerKind('doc.pdf')).toBe('pdf');
    expect(viewerKind('README.md')).toBe('markdown');
    expect(viewerKind('main.ts')).toBe('text');
    expect(viewerKind('.bashrc')).toBe('text');
    expect(monacoLanguage('src/app.tsx')).toBe('typescript');
    expect(monacoLanguage('Dockerfile')).toBe('dockerfile');
    expect(monacoLanguage('notes')).toBe('plaintext');
    expect(monacoLanguage('.env')).toBe('plaintext');
  });

  it('hides noise folders unless asked', () => {
    const entries = [{ noise: false }, { noise: true }];
    expect(visibleEntries(entries, false)).toHaveLength(1);
    expect(visibleEntries(entries, true)).toHaveLength(2);
  });

  it('formats sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
  });
});

describe('invalidateFiles', () => {
  it('refreshes one bot home, or every bot view of the team share', () => {
    const qc = new QueryClient();
    const keys = [
      fileKeys.dir('bot_a', 'home', ''),
      fileKeys.dir('bot_b', 'home', ''),
      fileKeys.dir('bot_a', 'shared', ''),
      fileKeys.content('bot_b', 'shared', 'k.md'),
    ];
    for (const k of keys) qc.setQueryData(k, 1);
    const stale = () => keys.map((k) => qc.getQueryState(k)?.isInvalidated);

    invalidateFiles(qc, { botId: 'bot_a', root: 'home' });
    expect(stale()).toEqual([true, false, false, false]);
    invalidateFiles(qc, { botId: 'bot_a', root: 'shared' });
    expect(stale()).toEqual([true, false, true, true]);
  });
});
