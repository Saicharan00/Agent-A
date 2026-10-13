import { expect, type Page, test } from '@playwright/test';

/** Collects console errors/warnings and uncaught exceptions; asserted empty after each test. */
function trackConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

const h1 = (page: Page) => page.locator('main h1');
/** Unique per test run, even when repeats run in parallel workers. */
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test.describe('bot management', () => {
  let problems: string[];
  test.beforeEach(async ({ page }) => {
    problems = trackConsole(page);
  });
  test.afterEach(() => {
    expect(problems, 'console errors/warnings').toEqual([]);
  });

  test('create → sidebar + grid → edit instructions → archive → restore → delete', async ({ page }) => {
    const name = `QA Bot ${uid()}`;
    const sidebarBots = page.getByRole('list', { name: 'Bots' });

    // Create, with validation first.
    await page.goto('/bots/new');
    await expect(h1(page)).toHaveText('New bot');
    await page.getByRole('button', { name: 'Create bot' }).click();
    await expect(page.getByText('Name is required')).toBeVisible();
    await expect(page.getByLabel('Name', { exact: true })).toBeFocused();

    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Role').fill('Writes end-to-end tests');
    await page.getByLabel('Engine', { exact: true }).selectOption('codex');
    await page.getByLabel('Model').fill('gpt-5');
    await page.getByRole('radio', { name: 'hexagon' }).click();
    await page.getByLabel('RAM (MB)').fill('100');
    await page.getByRole('button', { name: 'Create bot' }).click();
    await expect(page.getByText('RAM must be a whole number')).toBeVisible();
    await page.getByLabel('RAM (MB)').fill('1024');
    await page.getByRole('textbox', { name: 'Instructions' }).fill('# Rules\n- Always **test** first');
    await page.getByRole('tab', { name: 'Preview' }).click();
    await expect(
      page.getByTestId('bot-instructions-preview').getByRole('heading', { name: 'Rules' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Create bot' }).click();

    // Lands on the bot page; the bot shows up in the sidebar and the grid.
    await expect(h1(page)).toHaveText(name);
    await expect(page).toHaveURL(/\/bots\/bot_/);
    const botUrl = page.url();
    await expect(page.getByText(/^Codex\s*· gpt-5$/).first()).toBeVisible();
    await expect(sidebarBots.getByRole('link', { name })).toBeVisible();

    await page.goto('/bots');
    const card = page.getByRole('article', { name });
    await expect(card).toBeVisible();
    await expect(card.getByText('Writes end-to-end tests')).toBeVisible();
    await expect(card.getByRole('link', { name: 'Chat' })).toHaveAttribute('href', /\/threads\/thr_/);
    await card.getByRole('button', { name: 'Computer' }).click();
    await expect(page.getByTestId('computer-bot')).toContainText(name);

    // Edit the instructions; the change survives a reload.
    await card.getByRole('link', { name: `${name} settings` }).click();
    await expect(h1(page)).toHaveText(name);
    await page.getByRole('textbox', { name: 'Instructions' }).fill('# Rules\n- Review every diff');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Bot saved')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Instructions' })).toHaveValue(
      '# Rules\n- Review every diff',
    );
    await expect(page.getByLabel('RAM (MB)')).toHaveValue('1024');

    // Archive: hidden from the sidebar and the active grid, listed under Archived.
    await page.getByRole('button', { name: 'Archive' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'This bot is archived' })).toBeVisible();
    await expect(sidebarBots.getByRole('link', { name })).toHaveCount(0);
    await page.goto('/bots');
    await expect(page.getByRole('article', { name })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Archived' }).click();
    const archived = page.getByRole('article', { name });
    await expect(archived).toBeVisible();

    // Restore: back in the sidebar and the grid.
    await archived.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByText(`${name} restored`)).toBeVisible();
    await expect(sidebarBots.getByRole('link', { name })).toBeVisible();
    await page.getByRole('tab', { name: 'Active' }).click();
    await expect(page.getByRole('article', { name })).toBeVisible();

    // Delete requires typing the exact name.
    await page.goto(botUrl);
    await page.getByRole('button', { name: 'Delete…' }).click();
    const dialog = page.getByRole('dialog', { name: `Delete ${name}?` });
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole('button', { name: 'Delete bot' });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(`Type ${name} to confirm`).fill(name.toLowerCase());
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(`Type ${name} to confirm`).fill(name);
    await dialog.getByRole('checkbox').check();
    await confirm.click();

    await expect(page).toHaveURL(/\/bots$/);
    await expect(page.getByRole('article', { name })).toHaveCount(0);
    await expect(sidebarBots.getByRole('link', { name })).toHaveCount(0);
    const gone = await page.request.get(`/api/bots/${botUrl.split('/').pop()}`);
    expect(gone.status()).toBe(404);
  });

  test('duplicate creates a copy with its own handle', async ({ page }) => {
    const name = `Dup Src ${uid()}`;
    const res = await page.request.post('/api/bots', {
      data: { name, engine: 'claude', instructions: 'Copy me' },
    });
    expect(res.status()).toBe(201);
    const src = (await res.json()) as { id: string; slug: string };

    await page.goto(`/bots/${src.id}`);
    await page.getByRole('button', { name: 'Duplicate' }).click();
    await expect(h1(page)).toHaveText(`${name} (copy)`);
    await expect(page.getByRole('textbox', { name: 'Instructions' })).toHaveValue('Copy me');
    await expect(page.getByLabel('Handle')).toHaveValue(`${src.slug}-copy`);

    // Clean up both through the API (the UI flow is covered above).
    const copyId = page.url().split('/').pop()!;
    for (const [id, n] of [
      [src.id, name],
      [copyId, `${name} (copy)`],
    ]) {
      const del = await page.request.delete(`/api/bots/${id}`, {
        data: { confirmName: n, deleteHome: true },
      });
      expect(del.status()).toBe(204);
    }
  });

  test('an unknown bot shows a not-found page', async ({ page }) => {
    await page.goto('/bots/bot_doesnotexist');
    await expect(h1(page)).toHaveText('Bot');
    await expect(page.getByText('Bot not found')).toBeVisible();
    // The browser logs the expected 404 of GET /api/bots/bot_doesnotexist; nothing else may be logged.
    problems = problems.filter((p) => !/status of 404/.test(p));
  });

  test('API validation errors are typed', async ({ request }) => {
    const bad = await request.post('/api/bots', { data: { name: 'x', engine: 'nope' } });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error.code).toBe('invalid_body');
  });
});
