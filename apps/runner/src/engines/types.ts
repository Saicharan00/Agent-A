import type { Bot } from '@agenta/db';
import type { Engine, EngineEvent } from '@agenta/shared';

/** Everything an engine needs for one turn. Paths are inside the bot's container. */
export type EngineRunInput = {
  bot: Pick<Bot, 'id' | 'name' | 'slug' | 'role' | 'engine' | 'model'>;
  threadId: string;
  /** Final prompt text (see prompt.ts buildPrompt). */
  prompt: string;
  /** Appended to the engine's system prompt (identity, platform rules). */
  systemPromptAppend: string;
  /** Engine session to resume (bot_thread_sessions.engine_session_id). */
  resumeSessionId?: string;
  /** MCP config file for this run (Platform MCP + Playwright), inside the container. */
  mcpConfigPath: string;
  /** Model override; defaults to the bot's model, then the CLI default. */
  model?: string;
  /** Working directory, normally /home/bot/work. */
  cwd: string;
};

/**
 * One interface for every engine. `run` yields normalized events and always ends with exactly one
 * `run.finished`; aborting `signal` must end the run promptly with status `cancelled`.
 */
export interface EngineAdapter {
  readonly id: Engine;
  run(input: EngineRunInput, signal: AbortSignal): AsyncIterable<EngineEvent>;
}
