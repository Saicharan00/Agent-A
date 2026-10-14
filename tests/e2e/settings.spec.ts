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
