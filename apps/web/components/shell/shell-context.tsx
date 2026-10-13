'use client';

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { readBool, readStorage, STORAGE_KEYS, writeBool, writeStorage } from '@/lib/storage';
import { matchesShortcut, SHORTCUTS } from '@/lib/shortcuts';
import { type Theme, themeCookie } from '@/lib/theme';

export const COMPUTER_TABS = ['terminal', 'desktop', 'files', 'runs'] as const;
export type ComputerTab = (typeof COMPUTER_TABS)[number];

type ShellState = {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  computerOpen: boolean;
  setComputerOpen: (open: boolean) => void;
  computerTab: ComputerTab;
  setComputerTab: (tab: ComputerTab) => void;
  /** The bot whose computer the panel shows (null: none picked yet). */
  computerBotId: string | null;
  /** Focuses a bot's computer and opens the panel. */
  openComputer: (botId: string) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
};

const ShellContext = createContext<ShellState | null>(null);

export function useShell(): ShellState {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error('useShell must be used inside <ShellProvider>');
  return ctx;
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
  document.cookie = themeCookie(theme);
}

function storedTheme(): Theme | null {
  const v = readStorage(STORAGE_KEYS.theme);
  return v === 'light' || v === 'dark' ? v : null;
}

export function ShellProvider({ children, initialTheme }: { children: ReactNode; initialTheme: Theme }) {
  // The server already rendered `initialTheme` (from the cookie). Other persisted UI state is
  // read after mount so server and client markup match on hydration.
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [computerOpen, setComputerOpenState] = useState(false);
  const [computerTab, setComputerTabState] = useState<ComputerTab>('terminal');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [computerBotId, setComputerBotId] = useState<string | null>(null);

  useEffect(() => {
    // localStorage wins if the cookie was lost (e.g. cleared): re-apply and re-sync the cookie.
    const saved = storedTheme();
    if (saved && saved !== initialTheme) {
      setThemeState(saved);
      applyTheme(saved);
    }
    setSidebarCollapsed(readBool(STORAGE_KEYS.sidebarCollapsed, false));
    setComputerOpenState(readBool(STORAGE_KEYS.computerOpen, false));
    const tab = readStorage(STORAGE_KEYS.computerTab);
    if (tab && (COMPUTER_TABS as readonly string[]).includes(tab)) setComputerTabState(tab as ComputerTab);
  }, [initialTheme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    applyTheme(t);
    writeStorage(STORAGE_KEYS.theme, t);
  }, []);
  const toggleTheme = useCallback(() => setTheme(theme === 'dark' ? 'light' : 'dark'), [theme, setTheme]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((c) => {
      writeBool(STORAGE_KEYS.sidebarCollapsed, !c);
      return !c;
    });
  }, []);

  const setComputerOpen = useCallback((open: boolean) => {
    setComputerOpenState(open);
    writeBool(STORAGE_KEYS.computerOpen, open);
  }, []);

  const setComputerTab = useCallback((tab: ComputerTab) => {
    setComputerTabState(tab);
    writeStorage(STORAGE_KEYS.computerTab, tab);
  }, []);

  const openComputer = useCallback(
    (botId: string) => {
      setComputerBotId(botId);
      setComputerOpen(true);
    },
    [setComputerOpen],
  );

  // Global shortcuts.
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (matchesShortcut(ev, SHORTCUTS.palette)) {
        ev.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (matchesShortcut(ev, SHORTCUTS.toggleSidebar)) {
        ev.preventDefault();
        toggleSidebar();
      } else if (matchesShortcut(ev, SHORTCUTS.toggleComputer)) {
        ev.preventDefault();
        setComputerOpenState((o) => {
          writeBool(STORAGE_KEYS.computerOpen, !o);
          return !o;
        });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);

  const value = useMemo<ShellState>(
    () => ({
      theme,
      setTheme,
      toggleTheme,
      sidebarCollapsed,
      toggleSidebar,
      computerOpen,
      setComputerOpen,
      computerTab,
      setComputerTab,
      computerBotId,
      openComputer,
      paletteOpen,
      setPaletteOpen,
    }),
    [
      theme,
      setTheme,
      toggleTheme,
      sidebarCollapsed,
      toggleSidebar,
      computerOpen,
      setComputerOpen,
      computerTab,
      setComputerTab,
      computerBotId,
      openComputer,
      paletteOpen,
    ],
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}
