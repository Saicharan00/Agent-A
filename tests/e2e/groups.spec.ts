import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import type { BotView, ThreadView } from '../../packages/shared/src/index';

// Group chats & @mentions (F18) against the mock engine (playwright.config.ts forces AGENTA_ENGINE_OVERRIDE=mock).

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

async function createGroup(request: APIRequestContext, data: object): Promise<ThreadView> {
  const res = await request.post('/api/threads', { data });
  expect(res.status()).toBe(201);
  return (await res.json()) as ThreadView;
}

const turnsBy = (page: Page, bot: BotView) =>
  page.getByTestId('bot-turn').filter({ has: page.getByText(bot.name, { exact: true }) });

test.describe('group chats', () => {
  let problems: string[];
  test.beforeEach(async ({ page }) => {
    problems = trackConsole(page);
  });
  test.afterEach(() => {
    expect(problems, 'console errors/warnings').toEqual([]);
  });

  test('create a group, @mention two bots with autocomplete, both reply', async ({ page, request }) => {
    const alpha = await createBot(request, 'Alpha');
    const beta = await createBot(request, 'Beta');
    const title = `Launch ${uid()}`;
    await page.goto('/bots');

    await page.getByRole('button', { name: 'New group' }).click();
    const dialog = page.getByRole('dialog', { name: 'New group chat' });
    await dialog.getByLabel('Name').fill(title);
    await dialog.getByLabel('Purpose').fill('Ship v1');
    await dialog.getByRole('checkbox', { name: `Add ${alpha.name}` }).check();
    await dialog.getByRole('checkbox', { name: `Add ${beta.name}` }).check();
    await dialog.getByRole('button', { name: 'Create group' }).click();

    await expect(page).toHaveURL(/\/threads\/thr_/);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page.getByTestId('group-members')).toContainText('2');
    await expect(page.getByTestId('sidebar-group').filter({ hasText: title })).toBeVisible();

    // Autocomplete: "@" + part of the slug, Enter picks the highlighted bot.
    const box = page.getByRole('textbox', { name: `Message #${title}` });
    await box.pressSequentially(`@${alpha.slug.slice(0, 4)}`);
    const list = page.getByRole('listbox', { name: 'Mention a bot' });
    await expect(list.getByRole('option', { name: new RegExp(alpha.name) })).toBeVisible();
    await box.press('Enter');
    await expect(box).toHaveValue(`@${alpha.slug} `);
    await box.pressSequentially(`and @${beta.slug.slice(0, 4)}`);
    await list.getByRole('option', { name: new RegExp(beta.name) }).click();
    await box.pressSequentially('hello team');
    await expect(box).toHaveValue(`@${alpha.slug} and @${beta.slug} hello team`);
    await box.press('Control+Enter');
    await expect(box).toHaveValue('');

    for (const bot of [alpha, beta]) {
      const turn = turnsBy(page, bot);
      await expect(turn).toHaveCount(1);
      await expect(turn).toHaveAttribute('data-run-status', 'succeeded');
      await expect(turn.getByTestId('turn-text')).toContainText('You said:');
    }
  });

  test('a message without mentions goes to the moderator, who delegates via ask_bot', async ({
    page,
    request,
  }) => {
    const lead = await createBot(request, 'Mod');
    const helper = await createBot(request, 'Helper');
    const group = await createGroup(request, {
      title: `Mod ${uid()}`,
      memberBotIds: [lead.id, helper.id],
      moderatorBotId: lead.id,
    });
    await page.goto(`/threads/${group.id}`);
    const box = page.getByRole('textbox', { name: `Message #${group.title}` });
    await box.fill('build the login page [mock:moderate]');
    await box.press('Control+Enter');

    await expect(turnsBy(page, lead)).toContainText('Handed over.');
    await expect(page.getByTestId('message-bot').getByText('Could you take this one?')).toBeVisible();
    const helped = turnsBy(page, helper);
    await expect(helped).toHaveAttribute('data-run-status', 'succeeded');
    await expect(helped.getByTestId('turn-text')).toContainText('You said:');
  });

  test('add and remove members from the header', async ({ page, request }) => {
    const one = await createBot(request, 'One');
    const two = await createBot(request, 'Two');
    const group = await createGroup(request, { title: `Edit ${uid()}`, memberBotIds: [one.id] });
    await page.goto(`/threads/${group.id}`);

    await page.getByTestId('group-members').click();
    const dialog = page.getByRole('dialog', { name: `#${group.title}` });
    await dialog.getByRole('button', { name: `Add ${two.name}` }).click();
    await expect(dialog.getByRole('list', { name: 'Group members' })).toContainText(two.name);
    await expect(dialog.getByRole('button', { name: `Remove ${one.name}` })).toBeEnabled();
    await dialog.getByRole('button', { name: `Remove ${one.name}` }).click();
    await expect(dialog.getByRole('list', { name: 'Group members' })).not.toContainText(one.name);
    // The last member cannot be removed.
    await expect(dialog.getByRole('button', { name: `Remove ${two.name}` })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Close dialog' }).click();

    await expect(page.getByTestId('message-system')).toHaveText([
      `${two.name} joined the group.`,
      `${one.name} left the group.`,
    ]);
  });
});
