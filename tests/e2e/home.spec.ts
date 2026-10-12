import { expect, test } from '@playwright/test';

test('home page shows the runner is healthy', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Agent A', level: 1 })).toBeVisible();
  await expect(page.getByTestId('runner-status')).toHaveText('Runner: ok');
});
