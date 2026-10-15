import { readFileSync } from 'node:fs';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import type { BotView } from '../../packages/shared/src/index';

// Backup, export and factory reset (F32), against the mock engine. Backups go to data/e2e/backups.

function trackConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function createBot(request: APIRequestContext): Promise<BotView & { dmThreadId: string }> {
  const res = await request.post('/api/bots', { data: { name: `Export Bot ${uid()}`, engine: 'mock' } });
  expect(res.status()).toBe(201);
  return (await res.json()) as BotView & { dmThreadId: string };
}

test.describe('backup, export & reset', () => {
  let problems: string[];
  test.beforeEach(({ page }) => {
    problems = trackConsole(page);
  });
  test.afterEach(() => {
    expect(problems, 'console errors/warnings').toEqual([]);
  });

  test('export a conversation as Markdown', async ({ page, request }) => {
    const bot = await createBot(request);
    await page.goto(`/threads/${bot.dmThreadId}`);
    const box = page.getByRole('textbox', { name: /^Message / });
    await box.fill('Remember the launch date');
    await box.press('Control+Enter');
    await expect(page.getByText('You said: Remember the launch date')).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('thread-view').getByRole('link', { name: 'Export', exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^thread-.*\.md$/);
    const md = readFileSync((await download.path())!, 'utf8');
    expect(md).toContain('**You** · ');
    expect(md).toContain('Remember the launch date');
    expect(md).toContain(`**${bot.name}** · `);
  });

  test('back up now, then factory reset (typing RESET) lands on the first-run wizard', async ({
    page,
    request,
  }) => {
    await createBot(request);
    await page.goto('/settings');
    const section = page.getByRole('region', { name: 'Backups' });
    const rows = section.getByTestId('backup-row');
    // The runner's first launch of the day already wrote a daily backup. Asked from the API: the list shows only the
    // newest 15, and repeated e2e runs push it off with manual and reset backups.
    const all = (await (await request.get('/api/backups')).json()) as { backups: { reason: string }[] };
    expect(all.backups.filter((b) => b.reason === 'daily').length).toBeGreaterThanOrEqual(1);
    const newest = await rows.first().locator('code').textContent();
    await section.getByRole('button', { name: 'Back up now' }).click();
    await expect(page.getByText('Backup written')).toBeVisible();
    await expect(rows.first().locator('code')).not.toHaveText(newest ?? '');
    await expect(rows.first()).toContainText('manual');
    await expect(section.getByText(/pnpm restore .*data\/e2e\/backups\//)).toBeVisible();

    await section.getByRole('button', { name: 'Factory reset…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Factory reset?' });
    const submit = dialog.getByRole('button', { name: 'Reset everything' });
    await expect(submit).toBeDisabled();
    await dialog.getByRole('textbox', { name: 'Type RESET to confirm' }).fill('reset');
    await expect(submit).toBeDisabled();
    await dialog.getByRole('textbox', { name: 'Type RESET to confirm' }).fill('RESET');
    await submit.click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('onboarding')).toBeVisible();
    expect(await (await request.get('/api/bots?archived=include')).json()).toEqual([]);
    const list = (await (await request.get('/api/backups')).json()) as { backups: { reason: string }[] };
    expect(list.backups[0]?.reason).toBe('reset');

    // Leave the shared e2e DB with the default team for the specs that follow.
    expect((await request.post('/api/onboarding/team')).status()).toBe(200);
  });
});
