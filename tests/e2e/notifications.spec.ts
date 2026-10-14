import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import type { BotView, NotificationListResponse } from '../../packages/shared/src/index';

// Notifications & activity inbox (F27) against the mock engine. Trigger rules (questions, failures, schedules,
// tasks, desktop preference) are covered by the runner unit tests.

function trackConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function createBot(request: APIRequestContext, name: string): Promise<BotView> {
  const res = await request.post('/api/bots', { data: { name: `${name} ${uid()}`, engine: 'mock' } });
  expect(res.status()).toBe(201);
  return (await res.json()) as BotView;
}

async function titles(request: APIRequestContext, unread = false): Promise<string[]> {
  const res = await request.get(`/api/notifications?limit=200${unread ? '&unread=1' : ''}`);
  return ((await res.json()) as NotificationListResponse).items.map((n) => n.title);
}

test.describe('notifications', () => {
  let problems: string[];
  test.beforeEach(({ page }) => {
    problems = trackConsole(page);
  });
  test.afterEach(() => {
    expect(problems, 'console errors/warnings').toEqual([]);
  });

  test('a bot asking a question raises a question notification', async ({ request }) => {
    const bot = await createBot(request, 'Curious');
    await request.post(`/api/threads/${bot.dmThreadId}/messages`, { data: { content: '[mock:hello] hi' } });
    await expect.poll(() => titles(request), { timeout: 15_000 }).toContain(`${bot.name} has a question`);
  });

  test('a run finishing in another thread creates an unread notification whose link opens that thread', async ({
    page,
    request,
  }) => {
    const away = await createBot(request, 'Away');
    const here = await createBot(request, 'Here');
    await request.post('/api/notifications/read-all');
    const frames: string[] = [];
    page.on('websocket', (ws) => {
      if (ws.url().endsWith('/ws')) ws.on('framereceived', (f) => frames.push(String(f.payload)));
    });
    await page.goto(`/threads/${here.dmThreadId}`);
    // The runner counts the thread as watched once the page subscribed to its live channel.
    await expect
      .poll(() => frames.some((f) => f.includes('"subscribed"') && f.includes(`watch:${here.dmThreadId}`)))
      .toBe(true);
    const bell = page.getByTestId('notifications-bell');

    // A reply in the thread being watched: no notification.
    await request.post(`/api/threads/${here.dmThreadId}/messages`, { data: { content: 'hi there' } });
    await expect(page.getByText(/You said:/).first()).toBeVisible();

    const res = await request.post(`/api/threads/${away.dmThreadId}/messages`, {
      data: { content: 'ping away' },
    });
    expect(res.status()).toBe(201);
    // Other specs run in parallel on the same DB, so only this bot's notifications are asserted.
    await expect.poll(() => titles(request), { timeout: 15_000 }).toContain(`${away.name} finished`);
    await expect(bell).toHaveAccessibleName(/\d+ unread/);
    expect(await titles(request)).not.toContain(`${here.name} finished`);

    await bell.click();
    const panel = page.getByRole('dialog', { name: 'Notifications' });
    const item = panel.getByTestId('notification').filter({ hasText: `${away.name} finished` });
    await expect(item).toHaveAttribute('data-unread', 'true');
    await item.getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/threads/${away.dmThreadId}$`));
    await expect(page.getByText('ping away').first()).toBeVisible();
    await expect.poll(() => titles(request, true)).not.toContain(`${away.name} finished`);

    // The inbox page and the home feed list it as read.
    await page.goto('/notifications');
    const row = page.getByTestId('notification').filter({ hasText: `${away.name} finished` });
    await expect(row).toBeVisible();
    await expect(row).not.toHaveAttribute('data-unread');
    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Recent activity' })).toBeVisible();
  });

  test('a thread open in a hidden tab still notifies', async ({ page, request }) => {
    const bot = await createBot(request, 'Hidden');
    const frames: string[] = [];
    page.on('websocket', (ws) => {
      if (ws.url().endsWith('/ws')) ws.on('framereceived', (f) => frames.push(String(f.payload)));
    });
    const watched = (type: string) =>
      frames.some((f) => f.includes(`"${type}"`) && f.includes(`watch:${bot.dmThreadId}`));
    await page.goto(`/threads/${bot.dmThreadId}`);
    await expect.poll(() => watched('subscribed')).toBe(true);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => watched('unsubscribed')).toBe(true);
    await request.post(`/api/threads/${bot.dmThreadId}/messages`, { data: { content: 'while away' } });
    await expect.poll(() => titles(request), { timeout: 15_000 }).toContain(`${bot.name} finished`);
  });

  test('mark all read from the inbox page and the unread filter', async ({ page, request }) => {
    const bot = await createBot(request, 'Busy');
    await request.post(`/api/threads/${bot.dmThreadId}/messages`, { data: { content: 'one' } });
    await expect.poll(() => titles(request), { timeout: 15_000 }).toContain(`${bot.name} finished`);
    await page.goto('/notifications');
    await page.getByRole('button', { name: /^Unread/ }).click();
    await expect(page.getByTestId('notification').filter({ hasText: bot.name })).toBeVisible();
    await page.getByRole('button', { name: 'Mark all read' }).click();
    await expect(page.getByTestId('notification').filter({ hasText: bot.name })).toHaveCount(0);
  });
});
