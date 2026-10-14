import { expect, test } from '@playwright/test';

// Playwright starts the runner with CLAUDE_CODE_OAUTH_TOKEN='' and an empty secrets dir (playwright.config.ts),
// so both engines must report "missing" with fix steps, and nothing secret-looking may appear.
test.describe('settings: engines', () => {
  test('shows each engine as not set up, with instructions', async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text());
    });
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Engines' })).toBeVisible();

    for (const [engine, step] of [
      ['claude', 'pnpm auth:claude'],
      ['codex', 'pnpm auth:codex'],
    ] as const) {
      const card = page.getByTestId(`engine-${engine}`);
      await expect(card.getByTestId(`engine-${engine}-state`)).toHaveText('missing');
      await expect(card.getByTestId(`engine-${engine}-state`)).toHaveAttribute('data-tone', 'warn');
      await expect(card.getByTestId(`engine-${engine}-mode`)).toHaveText('Not set up');
      await expect(card.getByText('How to fix')).toBeVisible();
      await expect(card).toContainText(step);
    }

    // Top-bar pills follow the same status.
    await expect(page.getByTestId('claude-status')).toHaveText('Claude: not set up');
    await expect(page.getByTestId('codex-status')).toHaveText('Codex: not set up');
    await expect(page.getByTestId('docker-status')).toHaveText(/Docker: (ok|no image|down)/);

    // Re-check asks the CLIs only inside a running computer; with none running it says so.
    await page.getByRole('button', { name: 'Re-check' }).click();
    await expect(page.getByTestId('engine-claude')).toContainText(
      /Start any bot computer|Docker is disabled|CLI/,
    );

    await expect(page.locator('body')).not.toContainText('sk-ant-');
    expect(problems).toEqual([]);
  });
});

test.describe('settings: team (F21)', () => {
  test('reset team to defaults restores instructions and shows the Lead Room', async ({ page, request }) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text());
    });
    // Make sure the team exists, then change one bot's instructions.
    expect((await request.post('/api/team/reset')).ok()).toBe(true);
    const bots = (await (await request.get('/api/bots')).json()) as { id: string; slug: string }[];
    const architect = bots.find((b) => b.slug === 'architect')!;
    await request.patch(`/api/bots/${architect.id}`, { data: { instructions: 'Edited by the owner.' } });

    await page.goto('/settings');
    await page.getByRole('button', { name: 'Reset team to defaults' }).click();
    const dialog = page.getByRole('dialog', { name: 'Reset team to defaults?' });
    await dialog.getByRole('button', { name: 'Reset team' }).click();
    await expect(page.getByText(/Team reset to defaults: restored 7 bots/)).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('link', { name: /Lead Room/ }).first()).toBeVisible();

    const after = (await (await request.get(`/api/bots/${architect.id}`)).json()) as { instructions: string };
    expect(after.instructions).toMatch(/^You are the Architect/);
    expect(problems).toEqual([]);
  });
});

test.describe('settings: connectors (F29)', () => {
  test('GitHub shows the missing token with set-up steps and saves which bots may use it', async ({
    page,
    request,
  }) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text());
    });
    const name = `Gh Bot ${Date.now()}`;
    const bot = (await (await request.post('/api/bots', { data: { name, engine: 'mock' } })).json()) as {
      id: string;
    };

    await page.goto('/settings');
    const card = page.getByTestId('connector-github');
    await expect(card.getByTestId('connector-github-token')).toHaveText('token missing');
    await expect(card).toContainText('GITHUB_TOKEN=');
    // click + retrying expect, not check(): the query cache re-renders a tick after the click.
    const enable = card.getByLabel('Enable GitHub');
    const botBox = card.getByLabel(name);
    await enable.click();
    await expect(enable).toBeChecked();
    await botBox.click();
    await expect(botBox).toBeChecked();

    await page.reload();
    await expect(enable).toBeChecked();
    await expect(botBox).toBeChecked();
    const all = (await (await request.get('/api/connectors')).json()) as { type: string; botIds: string[] }[];
    expect(all.find((c) => c.type === 'github')!.botIds).toContain(bot.id);

    await botBox.click();
    await expect(botBox).not.toBeChecked();
    await enable.click();
    await expect(enable).not.toBeChecked();
    expect(problems).toEqual([]);
  });
});
