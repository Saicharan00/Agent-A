import { execFileSync } from 'node:child_process';
import type { BotView } from '@agenta/shared';
import { expect, test } from '@playwright/test';

// Live desktop (F16) against a real bot computer (agenta-bot:latest in the sandbox's Docker). noVNC talks to the
// runner's /ws/desktop proxy, never to the container port.

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test.describe('live desktop', () => {
  test('connects, renders the screen, shows a new window, and toggles control', async ({ page, request }) => {
    test.setTimeout(240_000);
    const res = await request.post('/api/bots', { data: { name: `Desk Bot ${uid()}`, engine: 'mock' } });
    expect(res.status()).toBe(201);
    const bot = (await res.json()) as BotView;
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(e.message));
    try {
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto('/bots');
      await page.getByRole('article', { name: bot.name }).getByRole('button', { name: 'Computer' }).click();
      const panel = page.getByRole('complementary', { name: 'Computer' });
      await panel.getByRole('tab', { name: 'Desktop' }).click();

      // Opening the tab starts the stopped computer, then connects.
      const status = panel.getByTestId('desktop-status');
      await expect(status).toHaveAttribute('data-state', 'connected', { timeout: 150_000 });
      const canvas = panel.getByTestId('desktop').locator('canvas');
      await expect(canvas).toBeVisible();
      const box = (await canvas.boundingBox())!;
      expect(box.width).toBeGreaterThan(100);
      expect(box.width).toBeLessThanOrEqual(520); // scaled to the panel, not 1440 px wide

      // View-only by default.
      const control = panel.getByRole('button', { name: 'Take control' });
      await expect(control).toHaveAttribute('aria-pressed', 'false');

      // A window opened on :99 shows up on the canvas.
      await page.waitForTimeout(1000);
      const before = await canvas.screenshot();
      const computer = (await (await request.get(`/api/bots/${bot.id}/computer`)).json()) as {
        containerId: string;
      };
      execFileSync('docker', [
        'exec',
        '-d',
        '-u',
        'bot',
        '-e',
        'DISPLAY=:99',
        computer.containerId,
        'display',
        '-title',
        'agenta-e2e',
        '-size',
        '900x600',
        'xc:red',
      ]);
      await expect
        .poll(async () => Buffer.compare(before, await canvas.screenshot()) !== 0, { timeout: 20_000 })
        .toBe(true);

      await control.click();
      await expect(panel.getByRole('button', { name: 'In control' })).toHaveAttribute('aria-pressed', 'true');
      await panel.getByRole('button', { name: 'In control' }).click();
      await expect(panel.getByRole('button', { name: 'Take control' })).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Full screen' })).toBeVisible();

      // Leaving the tab disconnects.
      await panel.getByRole('tab', { name: 'Files' }).click();
      await expect(panel.getByTestId('desktop-status')).toHaveCount(0);
      execFileSync('docker', ['exec', computer.containerId, 'pkill', '-f', 'agenta-e2e']);
      expect(problems).toEqual([]);
    } finally {
      const del = await request.delete(`/api/bots/${bot.id}`, {
        data: { confirmName: bot.name, deleteHome: true },
      });
      expect(del.status()).toBe(204);
    }
  });
});
