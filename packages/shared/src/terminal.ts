import { z } from 'zod';

// Live terminal (F14): GET /ws/terminal/:botId?cols=&rows= opens a fresh `bash -l` (user `bot`, cwd /home/bot/work)
// in the bot's computer. Binary frames carry raw TTY bytes both ways' output (server → client); text frames are
// JSON control messages. Every connection is its own shell: reconnecting starts a new one.

export const TERMINAL_CWD = '/home/bot/work';
/** Open terminals per bot; one more is refused with `too_many_terminals`. */
export const MAX_TERMINALS_PER_BOT = 8;
export const TERMINAL_MIN_COLS = 2;
export const TERMINAL_MAX_COLS = 1000;
export const TERMINAL_MIN_ROWS = 1;
export const TERMINAL_MAX_ROWS = 500;

const cols = z.coerce.number().int().min(TERMINAL_MIN_COLS).max(TERMINAL_MAX_COLS);
const rows = z.coerce.number().int().min(TERMINAL_MIN_ROWS).max(TERMINAL_MAX_ROWS);

/** Query string of the upgrade request: the initial size (defaults 80×24). */
export const terminalQuerySchema = z.object({
  cols: cols.default(80),
  rows: rows.default(24),
});
export type TerminalQuery = z.infer<typeof terminalQuerySchema>;

/** Client → server text frames. Keystrokes go as `input` (UTF-8 string, as xterm's onData gives them). */
export const terminalClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(64 * 1024) }),
  z.object({ type: z.literal('resize'), cols, rows }),
]);
export type TerminalClientMessage = z.infer<typeof terminalClientMessageSchema>;

/**
 * Server → client text frames (output itself arrives as binary frames).
 * `starting`: the computer is being started for this terminal; `ready`: the shell is attached;
 * `exit`: the shell ended (the socket closes right after); `error`: the terminal could not open or broke.
 */
export const terminalServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('starting') }),
  z.object({ type: z.literal('ready'), terminalId: z.string() }),
  z.object({ type: z.literal('exit'), code: z.number().int().nullable() }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type TerminalServerMessage = z.infer<typeof terminalServerMessageSchema>;
