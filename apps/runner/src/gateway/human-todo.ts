import { appendFileSync, existsSync, readFileSync } from 'node:fs';

/**
 * Appends a numbered owner action to HUMAN_TODO.md (PLAN F35: network commands for new MCP servers), unless an item
 * already contains `key` (the command), so saving the same server again adds nothing.
 */
export function appendHumanTodo(file: string, item: { key: string; text: string }): boolean {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current.includes(item.key)) return false;
  const numbers = [...current.matchAll(/^- \[[ xX]\] (\d+)\./gm)].map((m) => Number(m[1]));
  const next = numbers.length ? Math.max(...numbers) + 1 : 1;
  const sep = current && !current.endsWith('\n') ? '\n' : '';
  appendFileSync(file, `${sep}- [ ] ${next}. ${item.text}\n`);
  return true;
}
