import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import type { BotView } from '../../packages/shared/src/index';

// Memory system (F22) against the mock engine (playwright.config.ts forces AGENTA_ENGINE_OVERRIDE=mock).

function trackConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    // The guard rejection is an expected 422 the browser logs as a failed resource.
    if (m.text().includes('status of 422')) return;
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

test.describe('memory', () => {
  let problems: string[];
  test.beforeEach(async ({ page }) => {
    problems = trackConsole(page);
  });
  test.afterEach(() => {
    expect(problems, 'console errors/warnings').toEqual([]);
  });

  test('bot memory tab: add, guard rejects a key, pin, search, delete; save_memory shows up live', async ({
    page,
    request,
  }) => {
    const bot = await createBot(request, 'Rememberer');
    await page.goto(`/bots/${bot.id}`);
    await page.getByRole('tab', { name: 'memory' }).click();
    const panel = page.getByRole('tabpanel');
    await expect(panel.getByText('No memories yet')).toBeVisible();

    // The guard refuses a fake API key with a reason.
    await panel.getByRole('button', { name: 'Add memory' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add memory' });
    await dialog.getByLabel('Title').fill('Deploy key');
    await dialog.getByLabel('Content').fill('Use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345 to deploy');
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Anthropic API key');

    await dialog.getByLabel('Title').fill('Deploy flow');
    await dialog.getByLabel('Content').fill('Deploy from **staging** first.');
    await dialog.getByLabel('Tags').fill('ops, deploy');
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(dialog).toBeHidden();
    const item = panel.getByRole('listitem', { name: 'Deploy flow' });
    await expect(item).toContainText('Added by you');
    await expect(item).toContainText('#ops #deploy');

    await item.getByRole('button', { name: 'Pin Deploy flow' }).click();
    await expect(item.getByLabel('Pinned')).toBeVisible();

    // The bot saves a memory itself (mock save_memory); it appears without a reload.
    await page.goto(`/threads/${bot.dmThreadId}`);
    const box = page.getByRole('textbox', { name: /^Message / });
    await box.fill('Remember this [mock:remember]');
    await box.press('Control+Enter');
    await expect(page.getByText('Noted: I will remember')).toBeVisible();
    await page.goto(`/bots/${bot.id}`);
    await page.getByRole('tab', { name: 'memory' }).click();
    const saved = panel.getByRole('listitem', { name: 'Owner prefers short answers' });
    await expect(saved).toContainText('Saved by the bot');
    // Pinned first.
    await expect(panel.getByRole('listitem').first()).toHaveAccessibleName('Deploy flow');

    await panel.getByLabel('Search memories').fill('deploying');
    await expect(panel.getByRole('listitem')).toHaveCount(1);
    await panel.getByLabel('Search memories').fill('');

    await saved.getByRole('button', { name: 'Delete Owner prefers short answers' }).click();
    await page
      .getByRole('dialog', { name: 'Delete memory?' })
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect(saved).toBeHidden();
    await expect(panel.getByRole('listitem')).toHaveCount(1);
  });

  test('shared knowledge page: add and edit a team memory', async ({ page }) => {
    const title = `Team rule ${uid()}`;
    await page.goto('/');
    await page.getByRole('link', { name: 'Knowledge' }).first().click();
    await expect(page.getByRole('heading', { name: 'Shared knowledge' })).toBeVisible();

    await page.getByRole('button', { name: 'Add memory' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add memory' });
    await dialog.getByLabel('Title').fill(title);
    await dialog.getByLabel('Content').fill('Small pull requests only.');
    await dialog.getByRole('button', { name: 'Add' }).click();
    const item = page.getByRole('listitem', { name: title });
    await expect(item).toContainText('Small pull requests only.');

    await item.getByRole('button', { name: `Edit ${title}` }).click();
    const edit = page.getByRole('dialog', { name: 'Edit memory' });
    await edit.getByLabel('Content').fill('Small pull requests, reviewed within a day.');
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(item).toContainText('reviewed within a day');
  });
});
