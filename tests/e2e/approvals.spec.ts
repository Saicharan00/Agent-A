import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import type { ApprovalView, BotView } from '../../packages/shared/src/index';

// Approvals (F25) against the mock engine: [mock:approval] calls request_approval, [mock:checkapproval] <id>
// calls check_approval. Expiry (24 h) is covered by the runner unit tests with a fake clock.

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
  const res = await request.post('/api/bots', { data: { name: `Pusher ${uid()}`, engine: 'mock' } });
  expect(res.status()).toBe(201);
  return (await res.json()) as BotView;
}

async function approvalOf(request: APIRequestContext, botId: string): Promise<ApprovalView> {
  const all = (await (await request.get('/api/approvals')).json()) as ApprovalView[];
  const mine = all.find((a) => a.botId === botId);
  expect(mine).toBeTruthy();
  return mine!;
}

async function send(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: /^Message / });
  await box.fill(text);
  await box.press('Control+Enter');
}

test.describe('approvals', () => {
  let problems: string[];
  test.beforeEach(({ page }) => {
    problems = trackConsole(page);
  });
  test.afterEach(() => {
    expect(problems, 'console errors/warnings').toEqual([]);
  });

  test('bot requests approval → shows on home and in the bell → approve with a note → check_approval says approved', async ({
    page,
    request,
  }) => {
    const bot = await createBot(request);
    await page.goto(`/threads/${bot.dmThreadId}`);
    await send(page, 'Push it [mock:approval]');
    await expect(page.getByText('I asked for your approval before pushing.')).toBeVisible();

    const card = (scope: Page | ReturnType<Page['getByRole']>) =>
      scope.getByRole('listitem', { name: `${bot.name} asks to: Push to origin/main` });

    await page.goto('/');
    const home = page.getByRole('region', { name: /Waiting for your approval/ });
    await expect(card(home)).toContainText('high risk');
    await expect(card(home)).toContainText('Push the 2 commits on main to GitHub.');

    const bell = page.getByTestId('notifications-bell');
    await expect(bell).toHaveAccessibleName(/approvals? waiting/);
    await bell.click();
    const panel = page.getByRole('dialog', { name: 'Approvals' });
    await card(panel).getByLabel('Note for the bot').fill('Only main, no force push');
    await card(panel).getByRole('button', { name: 'Approve' }).click();
    await expect(card(panel)).toHaveCount(0);
    await expect(card(home)).toHaveCount(0);

    const approval = await approvalOf(request, bot.id);
    expect(approval).toMatchObject({ status: 'approved', note: 'Only main, no force push' });
    await page.goto(`/threads/${bot.dmThreadId}`);
    await send(page, `Check ${approval.id} [mock:checkapproval]`);
    await expect(page.getByText(`Approval ${approval.id} is approved.`)).toBeVisible();
  });

  test('deny from the home page → check_approval says denied', async ({ page, request }) => {
    const bot = await createBot(request);
    await page.goto(`/threads/${bot.dmThreadId}`);
    await send(page, 'Push it [mock:approval]');
    await expect(page.getByText('I asked for your approval before pushing.')).toBeVisible();

    await page.goto('/');
    const card = page
      .getByRole('region', { name: /Waiting for your approval/ })
      .getByRole('listitem', { name: `${bot.name} asks to: Push to origin/main` });
    await card.getByRole('button', { name: 'Deny' }).click();
    await expect(card).toHaveCount(0);

    const approval = await approvalOf(request, bot.id);
    expect(approval.status).toBe('denied');
    await page.goto(`/threads/${bot.dmThreadId}`);
    await send(page, `Check ${approval.id} [mock:checkapproval]`);
    await expect(page.getByText(`Approval ${approval.id} is denied.`)).toBeVisible();
  });
});
