import { readFileSync } from 'node:fs';
import { applyTeamTemplate, closeDb, createRepos, loadTeamTemplate, openDb } from '@agenta/db';
import { expect, type Page, test } from '@playwright/test';
import type { HandoffBrief, TaskDetail } from '../../packages/shared/src/index';

// Learn area (F23 session 2) against the mock engine.

function trackConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Agent A (the lead) from the team template, and done tasks this week split 3 agent / 1 human. */
function seed(): void {
  const db = openDb('data/e2e/agenta.db');
  try {
    const repos = createRepos(db);
    applyTeamTemplate(repos, loadTeamTemplate('templates/team'), { restore: false });
    for (const executedBy of ['agent', 'agent', 'agent', 'human'] as const) {
      const t = repos.tasks.create({ title: `Seeded ${uid()}`, executedBy });
      repos.tasks.update(t.id, { status: 'done' });
    }
  } finally {
    closeDb(db);
  }
}

test.describe('learn: work split and briefs', () => {
  let problems: string[];
  test.beforeAll(() => seed());
  test.beforeEach(async ({ page }) => {
    problems = trackConsole(page);
  });
  test.afterEach(() => {
    expect(problems, 'console errors/warnings').toEqual([]);
  });

  test('work split chart renders weeks with the 80% target', async ({ page }) => {
    await page.goto('/learn');
    await page.getByRole('tab', { name: 'Work split' }).click();
    await expect(page.getByRole('list', { name: 'Legend' })).toContainText('80% target');
    await expect(page.getByTestId('work-split-bar')).toHaveCount(8);
    await expect(page.getByTestId('work-split-bar').last()).toHaveAttribute(
      'title',
      /bots \d+, mixed \d+, you \d+/,
    );
    await page.getByText('Show as table').click();
    await expect(page.getByRole('table')).toBeVisible();
  });

  test('carry-over brief: Agent A saves it, it passes the guard and can be copied', async ({
    page,
    request,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const title = `Handoff ${uid()} [mock:brief]`;
    const task = (await (await request.post('/api/tasks', { data: { title } })).json()) as TaskDetail;
    await page.goto('/learn');
    await page.getByRole('tab', { name: 'Briefs' }).click();
    await page.getByLabel('Brief source').selectOption(`task:${task.id}`);
    await page.getByRole('button', { name: 'Ask Agent A for a brief' }).click();
    await expect(page).toHaveURL(/\/threads\//);
    await expect(page.getByText('Saved the carry-over brief to /shared/handoff.').last()).toBeVisible({
      timeout: 20_000,
    });

    const briefs = (await (await request.get('/api/learn/briefs')).json()) as HandoffBrief[];
    const b = briefs.find((x) => x.title === 'Carry-over brief')!;
    expect(b.guard.ok).toBe(true);
    expect(readFileSync(`data/e2e${b.path}`, 'utf8')).toContain('**Risks:** scope creep.');

    await page.goto('/learn');
    await page.getByRole('tab', { name: 'Briefs' }).click();
    const item = page.getByRole('listitem', { name: 'Carry-over brief' }).first();
    await item.getByRole('button', { name: 'Copy' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('What to do');
  });

  test('ask Agent A why: the lead answers in the bot DM under its own name', async ({ page, request }) => {
    const res = await request.post('/api/bots', { data: { name: `Why Bot ${uid()}`, engine: 'mock' } });
    const bot = (await res.json()) as { dmThreadId: string };
    await request.post(`/api/threads/${bot.dmThreadId}/messages`, { data: { content: '[mock:hello] ping' } });
    await page.goto(`/threads/${bot.dmThreadId}`);
    await expect(page.getByText(/^Hello! I'm Why Bot/)).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Ask Agent A why' }).first().click();
    await expect(page.getByText('Asked Agent A why')).toBeVisible();
    await expect(page.getByText('Agent A', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Deleted bot')).toHaveCount(0);
  });

  test('weekly review: Agent A gets the week in its DM and replies', async ({ page }) => {
    await page.goto('/learn');
    await page.getByRole('button', { name: 'Weekly review' }).click();
    await expect(page).toHaveURL(/\/threads\//);
    await expect(page.getByText(/Work split this week/).last()).toBeVisible();
    await expect(page.getByText('Mock ·', { exact: false }).last()).toBeVisible({ timeout: 15_000 });
  });
});
