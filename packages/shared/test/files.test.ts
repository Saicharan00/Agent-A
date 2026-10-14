import { describe, expect, it } from 'vitest';
import { containerPath, fileNameSchema, fileUploadQuerySchema, locateContainerPath } from '../src/files';

describe('locateContainerPath', () => {
  it('maps bot paths to a root and a relative path', () => {
    expect(locateContainerPath('/home/bot/work/a.txt')).toEqual({ root: 'home', path: 'work/a.txt' });
    expect(locateContainerPath('/home/bot')).toEqual({ root: 'home', path: '' });
    expect(locateContainerPath('/shared/knowledge/x.md')).toEqual({ root: 'shared', path: 'knowledge/x.md' });
    expect(locateContainerPath('notes.md')).toEqual({ root: 'home', path: 'work/notes.md' });
    expect(locateContainerPath('/home/bot/work/../notes//n.md')).toEqual({
      root: 'home',
      path: 'notes/n.md',
    });
  });

  it('returns null outside both roots', () => {
    expect(locateContainerPath('/etc/passwd')).toBeNull();
    expect(locateContainerPath('/home/botx/a')).toBeNull();
    expect(locateContainerPath('/shared/../etc')).toBeNull();
    expect(locateContainerPath('/../..')).toBeNull();
    expect(locateContainerPath('  ')).toBeNull();
  });

  it('round-trips with containerPath', () => {
    expect(containerPath('home', 'work/a.txt')).toBe('/home/bot/work/a.txt');
    expect(containerPath('shared', '')).toBe('/shared');
  });
});

describe('file schemas', () => {
  it('accepts plain names only', () => {
    expect(fileNameSchema.safeParse('report final.pdf').success).toBe(true);
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\0b'])
      expect(fileNameSchema.safeParse(bad).success).toBe(false);
  });

  it('parses the upload query', () => {
    expect(fileUploadQuerySchema.parse({ root: 'home', name: 'a.txt' })).toEqual({
      root: 'home',
      path: '',
      name: 'a.txt',
      overwrite: false,
      allowFlagged: false,
    });
    expect(
      fileUploadQuerySchema.parse({ root: 'shared', path: 'x', name: 'a', overwrite: '1' }).overwrite,
    ).toBe(true);
  });
});
