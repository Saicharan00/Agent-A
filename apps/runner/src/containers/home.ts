import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

// Host-side folders bind-mounted into bot containers:
//   <botsDir>/<botId>/home → /home/bot      <sharedDir> → /shared
// The runner and the in-container `bot` user are both uid 1000, so files the runner writes here are the bot's own.

export function botHomeDir(botsDir: string, botId: string): string {
  if (!/^bot_[A-Za-z0-9_-]+$/.test(botId)) throw new Error(`Invalid bot id: ${botId}`);
  return join(botsDir, botId, 'home');
}

const PLACEHOLDER_CLAUDE = `# Bot instructions

This file is rendered by Agent A before each run (instructions + memory). Do not edit by hand.
`;
const PLACEHOLDER_AGENTS = PLACEHOLDER_CLAUDE;

/**
 * Creates the home layout if missing: work/, notes/, .claude/, .codex/ and placeholder CLAUDE.md / AGENTS.md.
 * Never overwrites existing files. Returns true when the home was created from scratch.
 */
export function bootstrapHome(home: string): boolean {
  const fresh = !existsSync(home);
  for (const d of ['work', 'notes', '.claude', '.codex']) mkdirSync(join(home, d), { recursive: true });
  for (const [file, body] of [
    ['CLAUDE.md', PLACEHOLDER_CLAUDE],
    ['AGENTS.md', PLACEHOLDER_AGENTS],
  ] as const) {
    const path = join(home, file);
    if (!existsSync(path)) writeFileSync(path, body);
  }
  return fresh;
}

/** Deletes everything inside `home` (the folder itself is kept). Refuses paths outside `botsDir`. */
export function wipeHome(botsDir: string, home: string): void {
  const root = resolve(botsDir) + sep;
  const target = resolve(home);
  if (!target.startsWith(root)) throw new Error(`Refusing to wipe ${target}: not under ${root}`);
  if (!existsSync(target)) return;
  for (const entry of readdirSync(target)) rmSync(join(target, entry), { recursive: true, force: true });
}

/**
 * Bot homes must support symlinks (npm, Python venvs, git). The repo's virtiofs workspace mount does not,
 * so data/bots and data/shared are bind-mounted from the VM disk (scripts/vm-mounts.sh). Returns an error
 * message when `dir` cannot hold a symlink.
 */
export function checkSymlinks(dir: string): string | null {
  mkdirSync(dir, { recursive: true });
  const link = join(dir, `.agenta-symlink-probe-${process.pid}`);
  try {
    symlinkSync('target', link);
    unlinkSync(link);
    return null;
  } catch (err) {
    return `${dir} does not support symlinks (${(err as Error).message}). Run scripts/vm-mounts.sh so it lives on the VM disk.`;
  }
}
