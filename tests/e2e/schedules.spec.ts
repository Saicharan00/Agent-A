import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import type { BotView, ScheduleView } from '../../packages/shared/src/index';

// Scheduled tasks (F26) against the mock engine (it echoes the prompt). Firing on the timer, skipping while an engine
// is limited and catching up after a sleep are covered by the runner unit tests with a fake clock.

function trackConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function createBot(request: APIRequestContext): Promise<BotView> {
  const res = await request.post('/api/bots', { data: { name: `Planner ${uid()}`, engine: 'mock' } });
  expect(res.status()).toBe(201);
  return (await res.json()) as BotView;
}

test.describe('schedules', () => {
  let problems: string[];
  test.beforeEach(({ page }) => {
    problems = trackConsole(page);
  });
  test.afterEach(() => {
    expect(problems, 'console errors/warnings').toEqual([]);
  });

  test('create a schedule → Run now → the new thread shows the bot output → history lists the run', async ({
    page,
    request,
  }) => {
    const bot = await createBot(request);
    const name = `Morning check ${uid()}`;
    await page.goto('/schedules');
    await page.getByRole('button', { name: 'New schedule' }).click();
    const form = page.getByRole('form', { name: 'New schedule' });
    await form.getByLabel('Name').fill(name);
    await form.getByLabel('Bot').selectOption({ label: bot.name });
    await form.getByLabel('Prompt').fill('Check the build');
    await form.getByLabel('Repeat').selectOption({ label: 'Once a week' });
    await form.getByLabel('Day').selectOption({ label: 'Friday' });
    await form.getByLabel('Time', { exact: true }).fill('16:45');
    await expect(form.getByText('cron 45 16 * * 5')).toBeVisible();
    await form.getByRole('button', { name: 'Create schedule' }).click();

    const card = page.getByRole('listitem', { name: `Schedule ${name}` });
    await expect(card).toContainText('Fridays at 16:45');
    await expect(card).toContainText('America/New_York');
    const saved = ((await (await request.get('/api/schedules')).json()) as ScheduleView[]).find(
      (s) => s.name === name,
    );
    expect(saved).toMatchObject({ botId: bot.id, cron: '45 16 * * 5', enabled: true, threadId: null });
    expect(saved?.nextRunAt).toBeTruthy();

    await card.getByRole('button', { name: 'Run now' }).click();
    await expect(page).toHaveURL(/\/threads\/thr_/);
    await expect(page.getByText(/You said:/).first()).toBeVisible();
    await expect(page.getByText('Check the build').first()).toBeVisible();

    await page.goto('/schedules');
    await card.getByRole('button', { name: 'History' }).click();
    const history = card.getByRole('list', { name: 'Schedule history' });
    await expect(history).toContainText('started');
    await expect(history).toContainText('Run now');
    // The history refetches every 5 s while open; the run may still be finishing.
    await expect(history).toContainText('run succeeded', { timeout: 15_000 });
  });

  test('disable and delete a schedule', async ({ page, request }) => {
    const bot = await createBot(request);
    const name = `Old job ${uid()}`;
    const res = await request.post('/api/schedules', {
      data: { name, botId: bot.id, cron: '0 9 * * *', prompt: 'x' },
    });
    expect(res.status()).toBe(201);
    await page.goto('/schedules');
    const card = page.getByRole('listitem', { name: `Schedule ${name}` });
    await expect(card).toContainText('Every day at 09:00');
    await card.getByRole('button', { name: 'Disable' }).click();
    await expect(card).toContainText('Next run: off');
    page.once('dialog', (d) => void d.accept());
    await card.getByRole('button', { name: 'Delete' }).click();
    await expect(card).toHaveCount(0);
  });
});
