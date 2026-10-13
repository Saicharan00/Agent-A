// Keyboard shortcut parsing/matching. "Ctrl" also matches ⌘ so the same bindings work on macOS.

export type Shortcut = { ctrl: boolean; shift: boolean; alt: boolean; key: string };

export function parseShortcut(combo: string): Shortcut {
  const parts = combo.split('+').map((p) => p.trim());
  const key = parts.pop() ?? '';
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return {
    ctrl: mods.has('ctrl') || mods.has('mod'),
    shift: mods.has('shift'),
    alt: mods.has('alt'),
    key: key.toLowerCase(),
  };
}

// `key` can be missing: Chrome dispatches a keydown without it when an autofill suggestion is picked.
type KeyEventLike = { key?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean };

export function matchesShortcut(ev: KeyEventLike, combo: string): boolean {
  if (typeof ev.key !== 'string') return false;
  const s = parseShortcut(combo);
  return (
    ev.key.toLowerCase() === s.key &&
    (ev.ctrlKey || ev.metaKey) === s.ctrl &&
    ev.shiftKey === s.shift &&
    ev.altKey === s.alt
  );
}

/** App-wide bindings, shown in the palette and tooltips. */
export const SHORTCUTS = {
  palette: 'Ctrl+K',
  toggleSidebar: 'Ctrl+B',
  toggleComputer: 'Ctrl+\\',
  send: 'Ctrl+Enter',
} as const;
