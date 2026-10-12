import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Walks up from `start` to the directory holding pnpm-workspace.yaml. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Could not find repo root above ${start}`);
    dir = parent;
  }
}

/**
 * Loads `<repo>/.env.local` into process.env without overriding variables that are
 * already set, so shell/Playwright overrides win. Returns the path loaded, if any.
 */
export function loadRootEnv(start?: string): string | undefined {
  const file = join(findRepoRoot(start), '.env.local');
  if (!existsSync(file)) return undefined;
  process.loadEnvFile(file);
  return file;
}
