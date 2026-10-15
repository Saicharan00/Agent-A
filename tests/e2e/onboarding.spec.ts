import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { closeDb, createRepos, openDb } from '@agenta/db';
import { ONBOARDING_HELLO } from '../../packages/shared/src/index';

// First-run wizard and Settings → General / Health check (F31), against the mock engine.

function trackConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

/** Empties the shared e2e DB of bots, so the app looks freshly installed. The lead can't be deleted, so demote it first. */
async function deleteAllBots(request: APIRequestContext): Promise<void> {
  const bots = (await (await request.get('/api/bots?archived=include')).json()) as {
    id: string;
    name: string;
    isLead: boolean;
  }[];
  const db = openDb('data/e2e/agenta.db');
  try {
    const repos = createRepos(db);
    for (const b of bots) if (b.isLead) repos.bots.update(b.id, { isLead: false });
  } finally {
    closeDb(db);
  }
  for (const b of bots) {
    const res = await request.delete(`/api/bots/${b.id}`, {
      data: { confirmName: b.name, deleteHome: true },
    });
    expect(res.status(), `delete ${b.name}`).toBe(204);
  }
}

test.describe('onboarding & settings', () => {
  let problems: string[];
  test.beforeEach(({ page }) => {
    problems = trackConsole(page);
  });
  test.afterEach(() => {
    expect(problems, 'console errors/warnings').toEqual([]);
  });

  test('empty DB → wizard → team created and Agent A greeted', async ({ page, request }) => {
    await deleteAllBots(request);
    await page.goto('/');
    const wizard = page.getByTestId('onboarding');
    await expect(wizard).toBeVisible();
    await expect(wizard.getByRole('heading', { name: 'Docker and the bot computer image' })).toBeVisible();
    await expect(wizard.getByTestId('doctor-docker')).toBeVisible();
    await expect(wizard.getByTestId('doctor-image')).toBeVisible();
    // Engines are "not set up" in e2e (playwright.config.ts), with fix steps.
    await expect(wizard.getByTestId('engine-claude-state')).toHaveText('missing');
    await expect(wizard.getByTestId('engine-claude')).toContainText('pnpm auth:claude');

    await wizard.getByRole('button', { name: 'Create the team' }).click();
    await expect(page).toHaveURL(/\/threads\/thr_/);
    await expect(page.getByTestId('message-user').getByText(ONBOARDING_HELLO)).toBeVisible();
    await expect(page.getByText(`You said: ${ONBOARDING_HELLO}`)).toBeVisible();

    const bots = (await (await request.get('/api/bots')).json()) as { name: string; isLead: boolean }[];
    expect(bots).toHaveLength(7);
    expect(bots.find((b) => b.isLead)?.name).toBe('Agent A');

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Agent A', level: 1 })).toBeVisible();
    await expect(page.getByText('Talk to Agent A')).toBeVisible();
    await expect(page.getByTestId('onboarding')).toHaveCount(0);
  });

  test('settings: health check, general settings, theme and data folders', async ({ page }) => {
    await page.goto('/settings');
    const checks = page.getByRole('list', { name: 'Health checks' });
    for (const id of [
      'sandbox',
      'node',
      'pnpm',
      'docker',
      'image',
      'disk',
      'ports',
      'db',
      'engine-claude',
      'engine-codex',
    ])
      await expect(checks.getByTestId(`doctor-${id}`)).toBeVisible();
    await expect(checks.getByTestId('doctor-db')).toContainText('integrity check ok');
    await expect(checks.getByTestId('doctor-node')).toContainText('ok');

    const dl = page.getByRole('definition').filter({ hasText: 'data/e2e/agenta.db' });
    await expect(dl).toBeVisible();

    const form = page.getByRole('form', { name: 'General settings' });
    await form.getByLabel('Time zone').selectOption('Europe/London');
    await form.getByLabel('Memory (MB)').fill('1536');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Settings saved')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('form', { name: 'General settings' }).getByLabel('Time zone')).toHaveValue(
      'Europe/London',
    );

    // New bots start from the defaults; new schedules from the time zone.
    await page.goto('/bots/new');
    await expect(page.locator('#bot-memoryMb')).toHaveValue('1536');

    // Theme switch.
    await page.goto('/settings');
    await page.getByLabel('Theme', { exact: true }).selectOption('light');
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.getByLabel('Theme', { exact: true }).selectOption('dark');
    await expect(page.locator('html')).toHaveClass(/dark/);

    await expect(page.getByRole('form', { name: 'Usage settings' })).toBeVisible();

    // Restore the default so other specs see the usual values.
    const form2 = page.getByRole('form', { name: 'General settings' });
    await form2.getByLabel('Time zone').selectOption('America/New_York');
    await form2.getByLabel('Memory (MB)').fill('2048');
    await form2.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Settings saved').first()).toBeVisible();
  });
});
