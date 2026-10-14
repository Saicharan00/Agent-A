import { expect, type Page, test } from '@playwright/test';
import { closeDb, createRepos, openDb } from '@agenta/db';
import type { UsageReport } from '../../packages/shared/src/index';

// Usage & limits dashboard (F28). E2E forces the mock engine, so Codex runs only exist if seeded: seed them straight
// into the e2e DB, then check the page renders them and warns once the Codex daily budget reaches 80 %.

function trackConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A Codex bot with four finished runs (one hit the usage limit) started just now. */
function seedCodexRuns(name: string): void {
  const db = openDb('data/e2e/agenta.db');
  try {
    const repos = createRepos(db);
    const bot = repos.bots.create({ name, engine: 'codex' });
    for (let i = 0; i < 4; i++) {
      const run = repos.runs.create({ botId: bot.id, trigger: 'user', engine: 'codex', prompt: `p${i}` });
      repos.runs.markRunning(run.id);
      repos.runs.finish(
        run.id,
        i === 3
          ? { status: 'limited', error: 'Usage limit reached; codex paused until 2026-10-14T15:00:00.000Z' }
          : { status: 'succeeded', usage: { inputTokens: 1000, outputTokens: 200, costUsdEquivalent: 0.25 } },
      );
    }
  } finally {
    closeDb(db);
  }
}

test.describe('usage', () => {
  let problems: string[];
  test.beforeEach(async ({ page }) => {
    problems = trackConsole(page);
  });
  test.afterEach(async ({ request }) => {
    expect(problems, 'console errors/warnings').toEqual([]);
    await request.put('/api/usage/settings', { data: { maxConcurrentRuns: 2, budgets: {} } });
  });

  test('seeded runs render, and the Codex budget warns at 80 %', async ({ page, request }) => {
    const name = `Usage bot ${uid()}`;
    seedCodexRuns(name);
    const before = (await (await request.get('/api/usage')).json()) as UsageReport;
    const used = before.perEngine.find((e) => e.engine === 'codex')!.last24h;
    expect(used).toBeGreaterThanOrEqual(4);

    await page.goto('/usage');
    const bots = page.getByRole('region', { name: 'Bots' });
    await expect(bots.getByRole('row', { name: new RegExp(name) })).toContainText('4');
    const hits = page.getByRole('region', { name: 'Limit hits' });
    await expect(hits.getByRole('row', { name: new RegExp(name) })).toContainText('Codex');
    await expect(page.getByText('Equivalent, not billed')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Runs per day' }).getByRole('listitem')).toHaveCount(14);

    // A roomy budget: no warning.
    const form = page.getByRole('form', { name: 'Usage settings' });
    await form
      .getByLabel('Daily run budget')
      .nth(1)
      .fill(String(used * 10));
    await form.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Usage settings saved')).toBeVisible();
    await expect(page.getByTestId('budget-codex')).toContainText(`${used} of ${used * 10} runs`);
    await expect(page.getByRole('alert').filter({ hasText: 'Budget warning' })).toHaveCount(0);

    // used / (used + 1) is at least 80 % once used ≥ 4: the warning shows, the budget is not used up yet.
    await form
      .getByLabel('Daily run budget')
      .nth(1)
      .fill(String(used + 1));
    await form.getByRole('button', { name: 'Save settings' }).click();
    const warning = page.getByRole('alert').filter({ hasText: 'Budget warning' });
    await expect(warning).toContainText(`Codex: ${used} of ${used + 1} runs`);
    await expect(warning).toContainText('nearly used up');
    await expect(page.getByTestId('budget-codex')).toHaveAttribute('data-tone', 'warn');

    await page.reload();
    await expect(form.getByLabel('Daily run budget').nth(1)).toHaveValue(String(used + 1));
  });
});
