// localStorage can be missing or throw (private mode, blocked storage, SSR). Every access goes through here.

export function readStorage(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the preference just won't persist.
  }
}

export function readBool(key: string, fallback: boolean): boolean {
  const v = readStorage(key);
  return v === null ? fallback : v === '1';
}

export function writeBool(key: string, value: boolean): void {
  writeStorage(key, value ? '1' : '0');
}

export const STORAGE_KEYS = {
  theme: 'agenta.theme',
  sidebarCollapsed: 'agenta.sidebarCollapsed',
  computerOpen: 'agenta.computerOpen',
  computerTab: 'agenta.computerTab',
  filesShowHidden: 'agenta.filesShowHidden',
} as const;
