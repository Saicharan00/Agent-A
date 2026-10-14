import { customAlphabet } from 'nanoid';

/** Prefix per entity (CLAUDE.md: "IDs: nanoid with prefixes"). */
export const ID_PREFIXES = {
  bot: 'bot',
  thread: 'thr',
  message: 'msg',
  run: 'run',
  task: 'tsk',
  taskEvent: 'tev',
  memory: 'mem',
  decision: 'dec',
  lesson: 'lsn',
  approval: 'apr',
  schedule: 'sch',
  scheduleRun: 'shr',
  notification: 'ntf',
  connector: 'con',
  guardTerm: 'grd',
  terminal: 'trm',
  desktop: 'dsk',
  goal: 'gol',
} as const;
export type IdKind = keyof typeof ID_PREFIXES;

// Alphanumeric only, so IDs are safe in URLs, file names and double-click selection.
const nano = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 16);

export function newId<K extends IdKind>(kind: K): `${(typeof ID_PREFIXES)[K]}_${string}` {
  return `${ID_PREFIXES[kind]}_${nano()}`;
}

export function hasIdPrefix(id: string, kind: IdKind): boolean {
  return id.startsWith(`${ID_PREFIXES[kind]}_`);
}
