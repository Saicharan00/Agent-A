import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Repos } from '@agenta/db';
import { botHomeDir } from '../containers/home';

// Per-bot Platform MCP credential (PLAN F12/F17). The DB only stores a SHA-256 hash; the plaintext lives in one
// file inside the bot's own home, from which F17 renders the bot's MCP config. Nothing else ever sees it.

/** Path of the plaintext token inside a bot home (host side). In the container: /home/bot/.agenta/mcp-token. */
export const MCP_TOKEN_FILE = join('.agenta', 'mcp-token');

const TOKEN_PREFIX = 'agm_';

export function generateMcpToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function hashMcpToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time check of a presented token against a stored hash. */
export function verifyMcpToken(token: string, hash: string | null): boolean {
  if (!hash || !token.startsWith(TOKEN_PREFIX)) return false;
  const a = Buffer.from(hashMcpToken(token), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function tokenPath(botsDir: string, botId: string): string {
  return join(botHomeDir(botsDir, botId), MCP_TOKEN_FILE);
}

function writeToken(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // writeFileSync's mode only applies when the file is created
}

/** Issues a fresh token: writes the plaintext into the bot's home and stores only its hash. */
export function rotateMcpToken(repos: Pick<Repos, 'bots'>, botsDir: string, botId: string): void {
  const token = generateMcpToken();
  writeToken(tokenPath(botsDir, botId), token);
  repos.bots.updateRuntime(botId, { mcpTokenHash: hashMcpToken(token) });
}

/**
 * Makes sure the bot has a usable token: the file exists and matches the stored hash. A wiped home or a duplicated
 * row without a file gets a new one. Returns true when a token was (re)issued.
 */
export function ensureMcpToken(repos: Pick<Repos, 'bots'>, botsDir: string, botId: string): boolean {
  const bot = repos.bots.get(botId);
  if (!bot) throw new Error(`Bot ${botId} not found`);
  const path = tokenPath(botsDir, botId);
  if (existsSync(path) && verifyMcpToken(readFileSync(path, 'utf8').trim(), bot.mcpTokenHash)) return false;
  rotateMcpToken(repos, botsDir, botId);
  return true;
}
