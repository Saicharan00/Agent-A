// Direct chat logic for the UI (F13): API calls, the merged transcript (messages + the runs they started), the
// per-run stream reducer and inline run states. Components only render what these return.
import {
  type BotView,
  type EngineQueueStateResponse,
  type GroupCreateRequest,
  type LiveEvent,
  type MessagePage,
  type MessageView,
  MAX_EVENT_BATCH_RUNS,
  type RetryTurnRequest,
  type RunEventItem,
  type RunEventsBatchResponse,
  type RunView,
  type SendMessageRequest,
  type ThreadUpdateRequest,
  inboxUploadResponseSchema,
  messagePageSchema,
  runEventsBatchResponseSchema,
  runViewSchema,
  sendMessageResponseSchema,
  threadViewSchema,
  unreadCountsSchema,
} from '@agenta/shared';
import type { InfiniteData } from '@tanstack/react-query';
import { z } from 'zod';
import { apiRequest } from './api';
import { activeLimit, clockTime } from './engines';
import { appendEventItem } from './timeline';

/** Runs fetched per thread to annotate the transcript (newest first). */
export const THREAD_RUNS_LIMIT = 100;
export const MESSAGE_PAGE_SIZE = 50;

const enc = encodeURIComponent;

export const threadsApi = {
  get: (id: string) => apiRequest(`/threads/${enc(id)}`, threadViewSchema),
  groups: () => apiRequest('/threads', z.array(threadViewSchema), { query: { kind: 'group' } }),
  createGroup: (body: GroupCreateRequest) =>
    apiRequest('/threads', threadViewSchema, { method: 'POST', body }),
  addMember: (id: string, botId: string) =>
    apiRequest(`/threads/${enc(id)}/members`, threadViewSchema, { method: 'POST', body: { botId } }),
  removeMember: (id: string, botId: string) =>
    apiRequest(`/threads/${enc(id)}/members/${enc(botId)}`, threadViewSchema, { method: 'DELETE' }),
  messages: (id: string, before?: string) =>
    apiRequest(`/threads/${enc(id)}/messages`, messagePageSchema, {
      query: { before, limit: MESSAGE_PAGE_SIZE },
    }),
  send: (id: string, body: SendMessageRequest) =>
    apiRequest(`/threads/${enc(id)}/messages`, sendMessageResponseSchema, { method: 'POST', body }),
  runs: (threadId: string) =>
    apiRequest('/runs', z.array(runViewSchema), { query: { threadId, limit: THREAD_RUNS_LIMIT } }),
  update: (id: string, body: ThreadUpdateRequest) =>
    apiRequest(`/threads/${enc(id)}`, threadViewSchema, { method: 'PATCH', body }),
  retry: (id: string, body: RetryTurnRequest) =>
    apiRequest(`/threads/${enc(id)}/retry`, runViewSchema, { method: 'POST', body }),
  markRead: (id: string) =>
    apiRequest(`/threads/${enc(id)}/read`, z.object({ lastReadAt: z.string() }), { method: 'POST' }),
  unread: () => apiRequest('/threads/unread', unreadCountsSchema),
  cancelRun: (runId: string) => apiRequest(`/runs/${enc(runId)}/cancel`, runViewSchema, { method: 'POST' }),
  upload: (botId: string, file: File, signal?: AbortSignal) =>
    apiRequest(`/bots/${enc(botId)}/inbox`, inboxUploadResponseSchema, {
      method: 'POST',
      raw: file,
      query: { name: file.name },
      signal,
    }),
};

// ---------- messages cache (infinite query, newest page first) ----------

export type MessagesData = InfiniteData<MessagePage, unknown>;

/** All loaded messages, oldest first. */
export function flattenPages(data: MessagesData | undefined): MessageView[] {
  if (!data) return [];
  return [...data.pages].reverse().flatMap((p) => p.messages);
}

/**
 * Adds or replaces a message in the cached pages. New messages go to the end of the newest page (they are the
 * latest). Returns the data unchanged when there is nothing to do.
 */
export function upsertMessage(data: MessagesData, msg: MessageView): MessagesData {
  let found = false;
  const pages = data.pages.map((p) => {
    if (!p.messages.some((m) => m.id === msg.id)) return p;
    found = true;
    return { ...p, messages: p.messages.map((m) => (m.id === msg.id ? { ...m, ...msg } : m)) };
  });
  if (found) return { ...data, pages };
  const [newest, ...rest] = data.pages;
  if (!newest) return { ...data, pages: [{ messages: [msg], hasMore: false }] };
  return { ...data, pages: [{ ...newest, messages: [...newest.messages, msg] }, ...rest] };
}

/** Patches the content of a cached message; null when it isn't cached. */
export function patchMessageContent(data: MessagesData, id: string, contentMd: string): MessagesData | null {
  if (!data.pages.some((p) => p.messages.some((m) => m.id === id))) return null;
  return {
    ...data,
    pages: data.pages.map((p) => ({
      ...p,
      messages: p.messages.map((m) => (m.id === id ? { ...m, contentMd } : m)),
    })),
  };
}

// ---------- transcript ----------

export type TranscriptItem =
  | { kind: 'message'; message: MessageView }
  /** A bot turn: its reply (once written) plus its live/final state. */
  | { kind: 'run'; run: RunView; reply: MessageView | undefined };

export const ACTIVE_RUN_STATUSES: ReadonlySet<RunView['status']> = new Set(['queued', 'running']);

export function isActiveRun(run: Pick<RunView, 'status'>): boolean {
  return ACTIVE_RUN_STATUSES.has(run.status);
}

/**
 * Merges the loaded messages with the thread's runs. Each run is shown right after the user message that started
 * it (a usage-limit retry after its original), and owns its bot reply. Runs whose user message isn't loaded sit
 * where their reply is, or at the end when they are newer than everything loaded; older ones are left out.
 */
export function buildTranscript(messages: MessageView[], runs: RunView[]): TranscriptItem[] {
  const runById = new Map(runs.map((r) => [r.id, r]));
  const replyByRun = new Map<string, MessageView>();
  for (const m of messages) {
    if (m.authorType === 'bot' && m.runId && runById.has(m.runId) && !replyByRun.has(m.runId)) {
      replyByRun.set(m.runId, m);
    }
  }
  const userAnchors = new Map<string, MessageView>();
  for (const m of messages) if (m.authorType === 'user' && m.runId) userAnchors.set(m.runId, m);
  const anchorOf = (run: RunView): MessageView | undefined =>
    userAnchors.get(run.id) ?? (run.retryOfRunId ? userAnchors.get(run.retryOfRunId) : undefined);

  const byAnchor = new Map<string, RunView[]>();
  const atReply = new Map<string, RunView>();
  const trailing: RunView[] = [];
  const oldest = messages[0]?.createdAt;
  // Oldest first, so an original run precedes its retry.
  for (const run of [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const anchor = anchorOf(run);
    const reply = replyByRun.get(run.id);
    if (anchor) byAnchor.set(anchor.id, [...(byAnchor.get(anchor.id) ?? []), run]);
    else if (reply) atReply.set(reply.id, run);
    else if (!oldest || run.createdAt >= oldest) trailing.push(run);
  }

  const items: TranscriptItem[] = [];
  const runItem = (run: RunView): TranscriptItem => ({ kind: 'run', run, reply: replyByRun.get(run.id) });
  for (const m of messages) {
    const owner = m.runId && replyByRun.get(m.runId) === m ? m.runId : null;
    if (owner) {
      const run = atReply.get(m.id);
      if (run) items.push(runItem(run));
      continue; // rendered inside its run
    }
    items.push({ kind: 'message', message: m });
    for (const run of byAnchor.get(m.id) ?? []) items.push(runItem(run));
  }
  for (const run of trailing) items.push(runItem(run));
  return items;
}

// ---------- run timelines ----------

/** The live events of one run so far (consecutive deltas merged), and the last seq seen. */
export type RunStream = { lastSeq: number; items: RunEventItem[] };

export const EMPTY_STREAM: RunStream = { lastSeq: 0, items: [] };

/** Folds a `run.event` for this run into the stream; other events and repeats (seq ≤ lastSeq) are ignored. */
export function applyStreamEvent(state: RunStream, runId: string, live: LiveEvent): RunStream {
  if (live.type !== 'run.event' || live.runId !== runId || live.seq <= state.lastSeq) return state;
  return { lastSeq: live.seq, items: appendEventItem(state.items, { seq: live.seq, event: live.event }) };
}

/**
 * Loads finished runs' timelines in batches: every `load(id)` made in the same tick shares one
 * GET /api/runs/events request (up to MAX_EVENT_BATCH_RUNS ids each). Unknown runs resolve to [].
 */
export function createRunEventsLoader(
  fetchBatch: (ids: string[]) => Promise<RunEventsBatchResponse> = (ids) =>
    apiRequest('/runs/events', runEventsBatchResponseSchema, { query: { ids: ids.join(',') } }),
) {
  let waiting = new Map<string, { resolve: (v: RunEventItem[]) => void; reject: (e: unknown) => void }[]>();
  let scheduled = false;

  async function flush() {
    scheduled = false;
    const batch = waiting;
    waiting = new Map();
    const ids = [...batch.keys()];
    for (let i = 0; i < ids.length; i += MAX_EVENT_BATCH_RUNS) {
      const chunk = ids.slice(i, i + MAX_EVENT_BATCH_RUNS);
      try {
        const res = await fetchBatch(chunk);
        for (const id of chunk) for (const w of batch.get(id)!) w.resolve(res.runs[id]?.events ?? []);
      } catch (err) {
        for (const id of chunk) for (const w of batch.get(id)!) w.reject(err);
      }
    }
  }

  return {
    load(id: string): Promise<RunEventItem[]> {
      return new Promise((resolve, reject) => {
        waiting.set(id, [...(waiting.get(id) ?? []), { resolve, reject }]);
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(() => void flush());
        }
      });
    },
  };
}

export const runEventsLoader = createRunEventsLoader();

// ---------- inline run state ----------

export type RunState = {
  tone: 'neutral' | 'warn' | 'error' | 'ok';
  label: string;
  /** Show the typing indicator. */
  typing: boolean;
  /** Offer Stop / Cancel. */
  stoppable: boolean;
};

/** The one-line state under a bot turn, e.g. "Queued", "Limited — resumes at 14:05", "Stopped". */
export function runState(
  run: RunView,
  engines: EngineQueueStateResponse | undefined,
  retried: boolean,
  now = Date.now(),
): RunState | null {
  const until = activeLimit(engines?.engines.find((e) => e.engine === run.engine)?.limitedUntil, now);
  switch (run.status) {
    case 'queued':
      return until
        ? { tone: 'warn', label: `Limited — resumes at ${clockTime(until)}`, typing: false, stoppable: true }
        : { tone: 'neutral', label: 'Queued', typing: false, stoppable: true };
    case 'running':
      return { tone: 'neutral', label: 'Working…', typing: true, stoppable: true };
    case 'cancelled':
      return { tone: 'neutral', label: 'Stopped', typing: false, stoppable: false };
    case 'failed':
      return {
        tone: 'error',
        label: `Failed: ${run.error ?? 'unknown error'}`,
        typing: false,
        stoppable: false,
      };
    case 'limited':
      return {
        tone: 'warn',
        label: retried
          ? `Usage limit reached — this turn runs again${until ? ` at ${clockTime(until)}` : ''}`
          : 'Usage limit reached',
        typing: false,
        stoppable: false,
      };
    case 'succeeded':
      return null;
  }
}

/** Runs that can still be stopped (the composer's Stop button cancels all of them). */
export function stoppableRuns(runs: RunView[]): RunView[] {
  return runs.filter(isActiveRun);
}

/** The bot's latest run in the thread when it can be retried (finished), else null. */
export function retryableRun(runs: RunView[], botId: string): RunView | null {
  const latest = runs
    .filter((r) => r.botId === botId)
    .reduce<RunView | null>((a, r) => (!a || r.createdAt > a.createdAt ? r : a), null);
  return latest && !isActiveRun(latest) ? latest : null;
}

/** The newest user message among the loaded ones (the one Edit applies to). */
export function lastUserMessage(messages: MessageView[]): MessageView | null {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.authorType === 'user') return messages[i]!;
  return null;
}

// ---------- @mentions (group composer) ----------

/** The `@partial` being typed just before the caret, or null when the caret is not in a mention. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|[^\w@])@([a-z0-9-]*)$/i.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2]!.length - 1, query: m[2]!.toLowerCase() };
}

/** Members matching a mention query: slug or name prefix first, then anywhere in the name. Up to 8. */
export function mentionCandidates<B extends Pick<BotView, 'slug' | 'name'>>(bots: B[], query: string): B[] {
  const starts = bots.filter((b) => b.slug.startsWith(query) || b.name.toLowerCase().startsWith(query));
  const rest = bots.filter((b) => !starts.includes(b) && b.name.toLowerCase().includes(query));
  return [...starts, ...rest].slice(0, 8);
}

/** Replaces the mention being typed with `@slug ` and returns the new text and caret. */
export function insertMention(
  text: string,
  caret: number,
  start: number,
  slug: string,
): { text: string; caret: number } {
  const inserted = `@${slug} `;
  const after = text.slice(caret).replace(/^\s/, '');
  return { text: text.slice(0, start) + inserted + after, caret: start + inserted.length };
}
