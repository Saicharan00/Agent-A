// TanStack Query keys shared by fetchers and the live-event cache updater (lib/live-cache.ts).
// Lists live under a 'list' segment so invalidating them leaves cached details alone.
export const queryKeys = {
  runnerStatus: ['runner-status'] as const,
  engineAuth: ['settings', 'engines'] as const,
  engineState: ['engine-state'] as const,
  /** Prefix of every bot list; `botList` adds the archived filter. */
  bots: ['bots', 'list'] as const,
  botList: (archived: 'exclude' | 'include' | 'only' = 'exclude') => ['bots', 'list', archived] as const,
  bot: (id: string) => ['bots', 'detail', id] as const,
  thread: (threadId: string) => ['threads', threadId, 'detail'] as const,
  /** Infinite query: pages of MessagePage, newest page first. */
  threadMessages: (threadId: string) => ['threads', threadId, 'messages'] as const,
  /** Prefix of every run list (refetched on run.updated). */
  runs: ['runs', 'list'] as const,
  threadRuns: (threadId: string) => ['runs', 'list', { threadId }] as const,
  /** A finished run's timeline (immutable once finished). */
  runEvents: (id: string) => ['runs', 'events', id] as const,
  unread: ['threads', 'unread'] as const,
  /** Group chats (sidebar). */
  groups: ['threads', 'groups'] as const,
  run: (id: string) => ['runs', 'detail', id] as const,
  /** Prefix of every task query (refetched on task.changed). */
  tasks: ['tasks'] as const,
  taskList: ['tasks', 'list'] as const,
  task: (id: string) => ['tasks', 'detail', id] as const,
  /** Prefix of every goal query (refetched on goal.changed and task.changed). */
  goals: ['goals'] as const,
  goalList: ['goals', 'list'] as const,
  /** Prefix of every memory query (refetched on memory.changed). */
  memories: ['memories'] as const,
  memoryList: (f: { scope: string; botId?: string; q?: string }) => ['memories', 'list', f] as const,
  /** Prefix of every Learn query (refetched on learn.changed). */
  learn: ['learn'] as const,
  decisions: (status?: string) => ['learn', 'decisions', status ?? 'all'] as const,
  lessons: ['learn', 'lessons'] as const,
};
