import { MAX_TERMINALS_PER_BOT } from '@agenta/shared';

// Terminal tabs per bot in the Computer panel (F14). Pure state helpers; TerminalPanel holds the state.

export type TerminalTab = { key: string; title: string };
export type BotTerminals = { list: TerminalTab[]; active: string | null; next: number };
export type TerminalTabs = Record<string, BotTerminals>;

export const MAX_TABS = MAX_TERMINALS_PER_BOT;

export function addTab(tabs: TerminalTabs, botId: string): TerminalTabs {
  const cur = tabs[botId] ?? { list: [], active: null, next: 1 };
  if (cur.list.length >= MAX_TABS) return tabs;
  const tab = { key: `${botId}:${cur.next}`, title: `bash ${cur.next}` };
  return { ...tabs, [botId]: { list: [...cur.list, tab], active: tab.key, next: cur.next + 1 } };
}

/** Closing the active tab activates its right neighbour (or the new last one). */
export function closeTab(tabs: TerminalTabs, botId: string, key: string): TerminalTabs {
  const cur = tabs[botId];
  if (!cur) return tabs;
  const i = cur.list.findIndex((t) => t.key === key);
  if (i < 0) return tabs;
  const list = cur.list.filter((t) => t.key !== key);
  const active = cur.active === key ? (list[Math.min(i, list.length - 1)]?.key ?? null) : cur.active;
  return { ...tabs, [botId]: { ...cur, list, active } };
}

/** Drops the tabs of bots that no longer exist (returns the same object when nothing changed). */
export function pruneBots(tabs: TerminalTabs, alive: Set<string>): TerminalTabs {
  const gone = Object.keys(tabs).filter((id) => !alive.has(id));
  if (gone.length === 0) return tabs;
  const out = { ...tabs };
  for (const id of gone) delete out[id];
  return out;
}
