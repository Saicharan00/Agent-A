import { execFileSync } from 'node:child_process';
import type { BotView } from '@agenta/shared';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

// Live terminal (F14) against a real bot computer (agenta-bot:latest in the sandbox's Docker). The engine stays
// mocked; only bash runs in the container.

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function createBot(request: APIRequestContext): Promise<BotView> {
  const res = await request.post('/api/bots', { data: { name: `Term Bot ${uid()}`, engine: 'mock' } });
  expect(res.status()).toBe(201);
  return (await res.json()) as BotView;
}

/** Login shells of the terminals (`bash -l`) running in the container, per `docker top`. */
function loginShells(containerId: string): number {
  const out = execFileSync('docker', ['top', containerId, '-eo', 'pid,user,args'], { encoding: 'utf8' });
  return out.split('\n').filter((l) => /\bbash -l\s*$/.test(l)).length;
}

const screen = (page: Page) => page.locator('[data-testid="terminal"]:visible .xterm-rows');

async function run(page: Page, command: string) {
  await page.locator('[data-testid="terminal"]:visible').click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

/** The last `SIZE=<rows> <cols>` printed by `echo SIZE=$(stty size)`. */
async function lastSize(page: Page): Promise<[number, number] | null> {
  const text = (await screen(page).textContent()) ?? '';
  const all = [...text.matchAll(/SIZE=(\d+) (\d+)/g)];
  const m = all.at(-1);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

test.describe('live terminal', () => {
  test('open a shell, run commands, resize, and closing a tab ends its exec', async ({ page, request }) => {
    test.setTimeout(240_000);
    const bot = await createBot(request);
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(e.message));
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto('/bots');
      await page.getByRole('article', { name: bot.name }).getByRole('button', { name: 'Computer' }).click();
      const panel = page.getByRole('complementary', { name: 'Computer' });
      await expect(panel.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');

      // Opening a terminal starts the stopped computer.
      await panel.getByRole('button', { name: 'Open terminal' }).click();
      const status = panel.locator('[data-testid="terminal-status"]:visible');
      await expect(status).toHaveAttribute('data-state', 'open', { timeout: 150_000 });
      await expect(screen(page)).toContainText('$', { timeout: 15_000 });

      await run(page, 'echo $USER && pwd');
      // Each output line is its own row in the DOM renderer (rows concatenate without newlines in textContent).
      const rows = async () => (await screen(page).locator('> div').allTextContents()).map((r) => r.trim());
      await expect.poll(rows).toEqual(expect.arrayContaining(['bot', '/home/bot/work']));

      // Resize: a bigger window gives a bigger panel, and the shell sees the new size.
      await run(page, 'echo SIZE=$(stty size)');
      await expect.poll(() => lastSize(page)).not.toBeNull();
      const before = (await lastSize(page))!;
      await page.setViewportSize({ width: 1700, height: 1000 });
      await page.waitForTimeout(500);
      await run(page, 'clear; echo SIZE=$(stty size)');
      await expect.poll(async () => (await lastSize(page))?.join(' ')).not.toBe(before.join(' '));
      const after = (await lastSize(page))!;
      expect(after[0]).toBeGreaterThan(before[0]);
      expect(after[1]).toBeGreaterThan(before[1]);

      // A second tab is a second shell.
      const computer = (await (await request.get(`/api/bots/${bot.id}/computer`)).json()) as {
        containerId: string;
      };
      await panel.getByRole('button', { name: 'New terminal' }).click();
      await expect(panel.getByRole('tab', { name: 'bash 2' })).toHaveAttribute('aria-selected', 'true');
      await expect(status).toHaveAttribute('data-state', 'open', { timeout: 30_000 });
      await expect.poll(() => loginShells(computer.containerId)).toBe(2);

      // Closing a tab ends its shell in the container.
      await panel.getByRole('button', { name: 'Close bash 2' }).click();
      await expect(panel.getByRole('tab', { name: 'bash 1' })).toHaveAttribute('aria-selected', 'true');
      await expect.poll(() => loginShells(computer.containerId), { timeout: 10_000 }).toBe(1);
      // The first shell kept its history.
      await expect(screen(page)).toContainText('SIZE=');

      // Exiting the shell offers a new one.
      await run(page, 'exit 7');
      await expect(status).toHaveAttribute('data-state', 'exited');
      await expect(status).toContainText('Shell exited (code 7)');
      await expect.poll(() => loginShells(computer.containerId), { timeout: 10_000 }).toBe(0);
      await status.getByRole('button', { name: 'New shell' }).click();
      await expect(status).toHaveAttribute('data-state', 'open', { timeout: 30_000 });
      await expect.poll(() => loginShells(computer.containerId)).toBe(1);

      // Closing the panel ends every shell.
      await panel.getByRole('button', { name: 'Close computer panel' }).click();
      await expect.poll(() => loginShells(computer.containerId), { timeout: 10_000 }).toBe(0);
      expect(problems).toEqual([]);
    } finally {
      const del = await request.delete(`/api/bots/${bot.id}`, {
        data: { confirmName: bot.name, deleteHome: true },
      });
      expect(del.status()).toBe(204);
    }
  });
});
