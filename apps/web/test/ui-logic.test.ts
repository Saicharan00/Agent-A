import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialsOf, readableTextColor } from '@/lib/avatar';
import { isActivePath, NAV_ITEMS } from '@/lib/nav';
import { matchesShortcut, parseShortcut } from '@/lib/shortcuts';
import { readBool, readStorage, writeBool, writeStorage } from '@/lib/storage';
import { parseTheme, themeCookie } from '@/lib/theme';

const key = (
  k: string,
  mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {},
) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('shortcuts', () => {
  it('parses combos', () => {
    expect(parseShortcut('Ctrl+Shift+P')).toEqual({ ctrl: true, shift: true, alt: false, key: 'p' });
    expect(parseShortcut('Ctrl+\\')).toEqual({ ctrl: true, shift: false, alt: false, key: '\\' });
  });

  it('matches Ctrl or ⌘ and requires exact modifiers', () => {
    expect(matchesShortcut(key('k', { ctrlKey: true }), 'Ctrl+K')).toBe(true);
    expect(matchesShortcut(key('K', { metaKey: true }), 'Ctrl+K')).toBe(true);
    expect(matchesShortcut(key('k'), 'Ctrl+K')).toBe(false);
    expect(matchesShortcut(key('k', { ctrlKey: true, shiftKey: true }), 'Ctrl+K')).toBe(false);
    expect(matchesShortcut(key('Enter', { ctrlKey: true }), 'Ctrl+Enter')).toBe(true);
  });

  it('ignores key events without a key (Chrome autofill)', () => {
    const autofill = { ...key('k', { ctrlKey: true }), key: undefined };
    expect(matchesShortcut(autofill, 'Ctrl+K')).toBe(false);
  });
});

describe('avatar helpers', () => {
  it('derives initials', () => {
    expect(initialsOf('Agent A')).toBe('AA');
    expect(initialsOf('code-reviewer')).toBe('CR');
    expect(initialsOf('echo')).toBe('EC');
    expect(initialsOf('   ')).toBe('?');
  });

  it('picks readable text colours', () => {
    expect(readableTextColor('#ffffff')).toBe('#000000');
    expect(readableTextColor('#facc15')).toBe('#000000');
    expect(readableTextColor('#1e1b4b')).toBe('#ffffff');
    // Mid indigo: white is 4.47:1 (fails WCAG AA), black 4.7:1.
    expect(readableTextColor('#6366f1')).toBe('#000000');
    expect(readableTextColor('#4f46e5')).toBe('#ffffff');
    expect(readableTextColor('nope')).toBe('#ffffff');
  });
});

describe('nav', () => {
  it('marks the active section', () => {
    expect(isActivePath('/', '/')).toBe(true);
    expect(isActivePath('/bots', '/')).toBe(false);
    expect(isActivePath('/bots/new', '/bots')).toBe(true);
    expect(isActivePath('/botsx', '/bots')).toBe(false);
  });

  it('lists every top-level route from the plan', () => {
    expect(NAV_ITEMS.map((i) => i.href)).toEqual([
      '/',
      '/bots',
      '/tasks',
      '/knowledge',
      '/learn',
      '/schedules',
      '/usage',
      '/settings',
    ]);
  });
});

describe('storage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips through localStorage', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
      },
    });
    writeStorage('a', 'x');
    writeBool('b', true);
    expect(readStorage('a')).toBe('x');
    expect(readBool('b', false)).toBe(true);
    expect(readBool('missing', true)).toBe(true);
  });

  it('never throws when storage is blocked or absent', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    expect(readStorage('a')).toBeNull();
    expect(() => writeStorage('a', 'x')).not.toThrow();
    vi.unstubAllGlobals();
    expect(readStorage('a')).toBeNull();
  });
});

describe('theme', () => {
  it('defaults to dark', () => {
    expect(parseTheme(null)).toBe('dark');
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('purple')).toBe('dark');
  });

  it('serialises the SSR cookie', () => {
    expect(themeCookie('light')).toBe('agenta.theme=light; Path=/; Max-Age=31536000; SameSite=Lax');
  });
});
