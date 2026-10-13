import { z } from 'zod';
import { DECISION_STATUSES, RISK_LEVELS, TASK_PRIORITIES, TASK_STATUSES } from './enums';

// Platform MCP tool inputs (PLAN F17). One zod object per tool: the runner's MCP server publishes them as the tools'
// JSON schemas and validates every call with them; the mock engine's platform calls go through the same parse.

export const PLATFORM_MCP_SERVER = 'agenta';
/** How engines name a Platform MCP tool in their event streams (Claude's naming; the Codex mapper uses it too). */
export const PLATFORM_TOOL_PREFIX = `mcp__${PLATFORM_MCP_SERVER}__`;

const id = z.string().trim().min(1).max(100);
const text = z.string().trim().min(1).max(20_000);

export const platformToolInputs = {
  whoami: z.object({}),
  list_bots: z.object({}),
  list_threads: z.object({}),
  read_thread: z.object({
    thread_id: id.describe('Thread id (from list_threads)'),
    limit: z.number().int().min(1).max(100).default(20).describe('How many recent messages, newest last'),
  }),
  post_message: z.object({
    thread_id: id.describe('A thread you are a member of'),
    text: text.describe('Markdown message'),
  }),
  ask_bot: z.object({
    bot: id.describe('Teammate handle (e.g. "writer") or bot id'),
    message: text.describe('What you need from them, with enough context to act on it'),
    thread_id: id
      .optional()
      .describe('A thread you share with them; default: their direct-message thread with the owner'),
  }),
  get_run_status: z.object({ run_id: id.describe('Run id (ask_bot returns one)') }),
  save_memory: z.object({
    title: z.string().trim().min(1).max(200),
    content: z.string().trim().min(1).max(50_000).describe('Markdown'),
    scope: z.enum(['bot', 'shared']).default('bot').describe('bot: only you; shared: the whole team'),
    tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  }),
  search_memory: z.object({
    query: z.string().trim().min(1).max(200),
    scope: z.enum(['bot', 'shared', 'all']).default('all'),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  create_task: z.object({
    title: z.string().trim().min(1).max(300),
    description: z.string().max(50_000).default('').describe('Markdown: what to do and why'),
    acceptance: z.string().max(20_000).default('').describe('Markdown: how we will know it is done'),
    assignee: id
      .optional()
      .describe(
        'Handle or bot id, or "self". Only the lead may assign others; default: you (lead: unassigned)',
      ),
    priority: z.enum(TASK_PRIORITIES).default('p2'),
    parent_task_id: id.optional().describe('Make it a sub-task of this task'),
  }),
  list_tasks: z.object({
    status: z.array(z.enum(TASK_STATUSES)).optional(),
    assignee: id.optional().describe('Handle, bot id or "self"'),
    parent_task_id: id.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  get_task: z.object({ id: id.describe('Task id') }),
  update_task: z.object({
    id,
    status: z
      .enum(['todo', 'in_progress', 'blocked'])
      .optional()
      .describe('Use submit_task_result to hand in work; only review_task closes a task'),
    note: z
      .string()
      .trim()
      .min(1)
      .max(20_000)
      .optional()
      .describe('Progress note added to the task timeline'),
  }),
  submit_task_result: z.object({
    id,
    summary: text.describe('Markdown: what you did, how you checked it, open issues'),
    artifacts: z
      .array(z.string().trim().min(1).max(1000))
      .max(50)
      .default([])
      .describe('Paths (e.g. /shared/...) or URLs of what you produced'),
  }),
  review_task: z.object({
    id,
    verdict: z.enum(['approve', 'request_changes']),
    feedback: text.describe('Markdown: what is good, what must change'),
  }),
  record_decision: z.object({
    title: z.string().trim().min(1).max(300),
    context: z.string().max(20_000).default(''),
    options: z.string().max(20_000).default('').describe('Markdown: the options considered'),
    decision: text,
    consequences: z.string().max(20_000).default(''),
    status: z.enum(DECISION_STATUSES).default('proposed'),
    task_id: id.optional(),
  }),
  add_lesson: z.object({
    topic: z.string().trim().min(1).max(200),
    lesson: text.describe('Markdown: the lesson for the owner, in plain words'),
    why_it_matters: z.string().max(20_000).default(''),
    task_id: id.optional().describe('The task it came from, if any'),
  }),
  request_approval: z.object({
    action: z.string().trim().min(1).max(200).describe('What you want to do, e.g. "Push to main"'),
    details: z.string().max(20_000).default('').describe('Markdown: exactly what will happen and why'),
    risk: z.enum(RISK_LEVELS).default('medium'),
  }),
  check_approval: z.object({ approval_id: id }),
  notify_owner: z.object({
    title: z.string().trim().min(1).max(300),
    body: z.string().max(5_000).default(''),
  }),
} as const;

export type PlatformToolName = keyof typeof platformToolInputs;
export type PlatformToolInput<N extends PlatformToolName> = z.infer<(typeof platformToolInputs)[N]>;
