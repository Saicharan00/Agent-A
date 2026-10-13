// Threads & chat API (F13): thread view, message pages, sending (with inbox attachments) and the run shape the
// chat shows inline.
import { z } from 'zod';
import { botViewSchema } from './bots';
import { runUsageSchema, threadUpdateSchema } from './dto';
import {
  AUTHOR_TYPES,
  ENGINES,
  NOTIFICATION_LEVELS,
  RUN_STATUSES,
  RUN_TRIGGERS,
  THREAD_KINDS,
} from './enums';
import { type EngineEvent, engineEventSchema } from './events';

/** Where chat attachments land inside the bot's computer (bind-mounted from data/bots/<id>/home/work/inbox). */
export const INBOX_DIR = '/home/bot/work/inbox';
/** Largest single attachment (bytes). The web → runner proxy and the runner body limit both allow this. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const MAX_MESSAGE_CHARS = 100_000;

export const messageViewSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  authorType: z.enum(AUTHOR_TYPES),
  authorBotId: z.string().nullable(),
  contentMd: z.string(),
  /** User messages: the run they started. Bot messages: the run that wrote them. */
  runId: z.string().nullable(),
  mentions: z.array(z.string()),
  createdAt: z.string(),
});
export type MessageView = z.infer<typeof messageViewSchema>;

/** GET /api/threads/:id/messages?before=&limit= — chronological; `hasMore` when older messages exist. */
export const messagePageQuerySchema = z.object({
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type MessagePageQuery = z.input<typeof messagePageQuerySchema>;

export const messagePageSchema = z.object({
  messages: z.array(messageViewSchema),
  hasMore: z.boolean(),
});
export type MessagePage = z.infer<typeof messagePageSchema>;

/** A run as the chat and run lists see it (the prompt is left out: it can be large). */
export const runViewSchema = z.object({
  id: z.string(),
  botId: z.string(),
  threadId: z.string().nullable(),
  taskId: z.string().nullable(),
  trigger: z.enum(RUN_TRIGGERS),
  status: z.enum(RUN_STATUSES),
  engine: z.enum(ENGINES),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  error: z.string().nullable(),
  usage: runUsageSchema.nullable(),
  retryOfRunId: z.string().nullable(),
});
export type RunView = z.infer<typeof runViewSchema>;

export const threadViewSchema = z.object({
  id: z.string(),
  kind: z.enum(THREAD_KINDS),
  title: z.string(),
  explainMode: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  /** When the owner last viewed it (unread counts). */
  lastReadAt: z.string().nullable(),
  /** Group chats: what the group is for. */
  purpose: z.string(),
  /** Group chats: the configured moderator (null = default: Agent A if a member, else the first member). */
  moderatorBotId: z.string().nullable(),
  /** Group chats: paused by the owner (bot mentions start no turns until the owner writes). */
  pausedAt: z.string().nullable(),
  /** Which messages count as unread: all, mentions (system + @owner) or none (muted). */
  notifications: z.enum(NOTIFICATION_LEVELS),
  members: z.array(botViewSchema),
});
export type ThreadView = z.infer<typeof threadViewSchema>;

function isControlChar(c: string): boolean {
  const code = c.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

function hasControlChars(s: string): boolean {
  return [...s].some(isControlChar);
}

/** A file name as stored in the inbox: no folders, no control characters, not hidden. */
export const inboxFileNameSchema = z
  .string()
  .min(1)
  .max(160)
  .refine((n) => !/[/\\]/.test(n) && !hasControlChars(n) && !n.startsWith('.'), 'not a plain file name');

/** POST /api/threads/:id/messages. `attachments` are names returned by the inbox upload. */
export const sendMessageRequestSchema = z
  .object({
    content: z.string().max(MAX_MESSAGE_CHARS).default(''),
    attachments: z.array(inboxFileNameSchema).max(MAX_ATTACHMENTS).default([]),
  })
  .strict()
  .refine((b) => b.content.trim() !== '' || b.attachments.length > 0, {
    message: 'write a message or attach a file',
    path: ['content'],
  });
export type SendMessageRequest = z.input<typeof sendMessageRequestSchema>;

export const sendMessageResponseSchema = z.object({
  message: messageViewSchema,
  runs: z.array(runViewSchema),
});
export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;

/** POST /api/bots/:id/inbox?name= (raw bytes): the stored name (deduplicated) and its path in the computer. */
export const inboxUploadQuerySchema = z.object({ name: z.string().min(1).max(500) });
export const inboxUploadResponseSchema = z.object({
  name: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
});
export type InboxUploadResponse = z.infer<typeof inboxUploadResponseSchema>;

/**
 * Turns whatever the browser called the file into a safe inbox name: last path segment, control characters and
 * separators dropped, no leading dots, at most 120 characters (extension kept).
 */
export function sanitizeInboxName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? '';
  let name = [...base]
    .filter((c) => !isControlChar(c))
    .join('')
    .trim()
    .replace(/^\.+/, '');
  if (name.length > 120) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name || 'file';
}

/** The text a bot sees for a user turn: the message, then the attached files' paths in its computer. */
export function composeUserPrompt(content: string, attachments: string[]): string {
  const text = content.trim();
  if (attachments.length === 0) return text;
  const list = attachments.map((n) => `- ${INBOX_DIR}/${n}`).join('\n');
  return `${text}${text ? '\n\n' : ''}The user attached ${attachments.length === 1 ? 'a file' : 'files'}:\n${list}`;
}

/** How the user's message is stored (and shown): the text, then the attachments as inline code. */
export function composeUserMessage(content: string, attachments: string[]): string {
  const text = content.trim();
  if (attachments.length === 0) return text;
  const list = attachments.map((n) => `\`inbox/${n}\``).join(' · ');
  return `${text}${text ? '\n\n' : ''}📎 ${list}`;
}

// ---------- session 2: thread settings, retry, unread, run timelines ----------

/** PATCH /api/threads/:id — rename or toggle Explain mode (used by the prompt builder on the next turn). */
export const threadUpdateRequestSchema = threadUpdateSchema
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'nothing to update' });
export type ThreadUpdateRequest = z.input<typeof threadUpdateRequestSchema>;

/** POST /api/threads/:id/retry — run the thread's last finished turn again with the same prompt. */
export const retryTurnRequestSchema = z.object({ runId: z.string().min(1) }).strict();
export type RetryTurnRequest = z.input<typeof retryTurnRequestSchema>;

/** GET /api/threads/unread — unseen bot/system messages per thread (threads with none are omitted). */
export const unreadCountsSchema = z.object({ counts: z.record(z.string(), z.number().int().nonnegative()) });
export type UnreadCounts = z.infer<typeof unreadCountsSchema>;

/** A thread got a new message. Channel: `global` (sidebars refresh unread counts; no content). */
export const liveThreadActivitySchema = z.object({
  type: z.literal('thread.activity'),
  threadId: z.string(),
  messageId: z.string(),
  authorType: z.enum(AUTHOR_TYPES),
});
export type LiveThreadActivity = z.infer<typeof liveThreadActivitySchema>;

export const runEventItemSchema = z.object({ seq: z.number().int().positive(), event: engineEventSchema });
export type RunEventItem = z.infer<typeof runEventItemSchema>;

export const MAX_EVENT_BATCH_RUNS = 50;
const RUN_ID_RE = /^run_[A-Za-z0-9]{1,64}$/;

/** GET /api/runs/events?ids=a,b — the timelines of several runs at once (chat transcripts). */
export const runEventsBatchQuerySchema = z.object({
  ids: z
    .string()
    .transform((v) => [...new Set(v.split(',').filter(Boolean))])
    .pipe(z.array(z.string().regex(RUN_ID_RE, 'not a run id')).min(1).max(MAX_EVENT_BATCH_RUNS)),
});

export const runEventsBatchResponseSchema = z.object({
  runs: z.record(z.string(), z.object({ status: z.enum(RUN_STATUSES), events: z.array(runEventItemSchema) })),
});
export type RunEventsBatchResponse = z.infer<typeof runEventsBatchResponseSchema>;

/** Tool output kept per result in a batched timeline; the rest is replaced by a note. */
export const MAX_TOOL_OUTPUT_CHARS = 64 * 1024;

/**
 * Shrinks a stored timeline for display: consecutive `text.delta`s merge into one (keeping the last seq) and huge
 * tool outputs are cut. Order and the meaning of every other event are unchanged.
 */
export function compactRunEvents(items: RunEventItem[]): RunEventItem[] {
  const out: RunEventItem[] = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    const e: EngineEvent = item.event;
    if (e.type === 'text.delta' && prev?.event.type === 'text.delta') {
      out[out.length - 1] = { seq: item.seq, event: { type: 'text.delta', text: prev.event.text + e.text } };
    } else if (e.type === 'tool.result' && e.output.length > MAX_TOOL_OUTPUT_CHARS) {
      const cut = e.output.length - MAX_TOOL_OUTPUT_CHARS;
      out.push({
        seq: item.seq,
        event: {
          ...e,
          output: `${e.output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (${cut} more characters not shown)`,
        },
      });
    } else {
      out.push(item);
    }
  }
  return out;
}

/** The inverse of composeUserMessage: the typed text and the attachment names (for edit-and-resend). */
export function splitUserMessage(contentMd: string): { content: string; attachments: string[] } {
  const m = /(?:^|\n\n)📎 ((?:`inbox\/[^`]+`(?: · )?)+)$/u.exec(contentMd);
  if (!m) return { content: contentMd, attachments: [] };
  const attachments = [...m[1]!.matchAll(/`inbox\/([^`]+)`/g)].map((x) => x[1]!);
  return { content: contentMd.slice(0, m.index), attachments };
}

// ---------- group chats (F18) ----------

/** POST /api/threads — a group chat with at least one member. */
export const groupCreateRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    purpose: z.string().trim().max(2000).default(''),
    memberBotIds: z.array(z.string().min(1)).min(1, 'pick at least one bot').max(50),
    moderatorBotId: z.string().min(1).nullable().default(null),
  })
  .strict();
export type GroupCreateRequest = z.input<typeof groupCreateRequestSchema>;

/** GET /api/threads?kind=group */
export const threadListQuerySchema = z.object({ kind: z.enum(THREAD_KINDS).optional() });

/** POST /api/threads/:id/members */
export const addMemberRequestSchema = z.object({ botId: z.string().min(1) }).strict();
export type AddMemberRequest = z.input<typeof addMemberRequestSchema>;

/** The text with fenced code blocks, inline code and quoted lines blanked out (mentions there don't count). */
function mentionableText(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
}

/**
 * The bots a message @mentions, in order of first mention: `@slug` (case-insensitive) for any of `bots`, not inside
 * code or a quote (quoting a message must not summon its mentions again).
 */
export function parseMentions(text: string, bots: { id: string; slug: string }[]): string[] {
  const bySlug = new Map(bots.map((b) => [b.slug.toLowerCase(), b.id]));
  const ids: string[] = [];
  for (const m of mentionableText(text).matchAll(/(^|[^\w@])@([a-z0-9][a-z0-9-]*)/gi)) {
    const id = bySlug.get(m[2]!.toLowerCase()) ?? bySlug.get(m[2]!.toLowerCase().replace(/-+$/, ''));
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
