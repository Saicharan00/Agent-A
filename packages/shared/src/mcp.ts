import { z } from 'zod';

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
} as const;

export type PlatformToolName = keyof typeof platformToolInputs;
export type PlatformToolInput<N extends PlatformToolName> = z.infer<(typeof platformToolInputs)[N]>;
