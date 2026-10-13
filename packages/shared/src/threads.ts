// Threads & chat API (F13): thread view, message pages, sending (with inbox attachments) and the run shape the
// chat shows inline.
import { z } from 'zod';
import { botViewSchema } from './bots';
import { runUsageSchema } from './dto';
import { AUTHOR_TYPES, ENGINES, RUN_STATUSES, RUN_TRIGGERS, THREAD_KINDS } from './enums';

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
