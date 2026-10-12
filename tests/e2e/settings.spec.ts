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
