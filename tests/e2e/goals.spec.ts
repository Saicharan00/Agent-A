import { expect, type Page, test } from '@playwright/test';
import { closeDb, createRepos, openDb } from '@agenta/db';
import type { GoalView, TaskView } from '../../packages/shared/src/index';

// Agent A delegation loop (F20) against the mock engine: goal → plan → confirm → 3 tasks → one round of changes →
// approvals → goal report. The lead's `[mock:plan]` scenario scripts Agent A's side.

function trackConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The e2e DB has no seeded team yet (F21), so make sure a lead exists, plus one specialist. */
function ensureTeam(): void {
  const db = openDb('data/e2e/agenta.db');
  try {
    const repos = createRepos(db);
    if (!repos.bots.getLead()) {
      repos.bots.create({
        name: 'Agent A',
        slug: 'agent-a',
        engine: 'mock',
        isLead: true,
        avatarColor: '#6366f1',
      });
    }
    if (!repos.bots.list().some((b) => !b.isLead)) {
      repos.bots.create({ name: 'Builder', engine: 'mock', avatarColor: '#10b981' });
    }
  } finally {
    closeDb(db);
  }
}

test.describe('goals', () => {
  let problems: string[];
  test.beforeAll(() => ensureTeam());
  test.beforeEach(async ({ page }) => {
    problems = trackConsole(page);
  });
  test.afterEach(() => {
    expect(problems, 'console errors/warnings').toEqual([]);
  });

  test('goal → plan → confirm → tasks, one rework, approvals → report', async ({ page, request }) => {
    const goalText = `Launch page ${uid()} [mock:plan]`;
    await page.goto('/');
    const form = page.getByRole('form', { name: 'New goal' });
    await form.getByLabel('Goal').fill(goalText);
    await form.getByLabel('Constraints').fill('No real customer data');
    await form.getByRole('button', { name: 'Start goal' }).click();

    // The goal's thread with Agent A: the plan, waiting for confirmation.
    await expect(page).toHaveURL(/\/threads\/thr_/);
    const bar = page.getByTestId('goal-bar');
    await expect(page.getByText('Confirm the plan to start.')).toBeVisible({ timeout: 15_000 });
    await expect(bar).toContainText('Waiting for you to confirm the plan');
    await bar.getByRole('button', { name: 'Confirm plan' }).click();

    // The whole loop runs on its own; the bar follows it live.
    await expect(bar).toContainText('Done', { timeout: 60_000 });
    await expect(bar.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    await expect(bar.getByTestId('goal-budget')).toContainText('3/3 tasks done');
    await expect(page.getByText('Requested changes: a usage example is missing.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Goal report' })).toBeVisible();

    const goals = (await (await request.get('/api/goals')).json()) as GoalView[];
    const goal = goals.find((g) => g.goalMd.startsWith(goalText))!;
    expect(goal).toMatchObject({ status: 'done', tasksTotal: 3, tasksDone: 3 });
    const tasks = ((await (await request.get('/api/tasks')).json()) as TaskView[]).filter(
      (t) => t.goalId === goal.id,
    );
    expect(tasks.map((t) => [t.status, t.revisionCount]).sort()).toEqual([
      ['done', 0],
      ['done', 0],
      ['done', 1],
    ]);

    // Home lists it with a full progress bar.
    await page.goto('/');
    const card = page.getByTestId('goal-card').filter({ hasText: goal.title });
    await expect(card).toContainText('Done');
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  test('pause stops new turns until resumed; the palette opens a new goal', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Control+k');
    await page.getByRole('option', { name: 'New goal' }).click();
    const goalInput = page.getByRole('form', { name: 'New goal' }).getByLabel('Goal');
    await expect(goalInput).toBeFocused();
    await goalInput.fill(`Pause me ${uid()} [mock:plan]`);
    await page.getByRole('button', { name: 'Start goal' }).click();

    const bar = page.getByTestId('goal-bar');
    await expect(page.getByText('Confirm the plan to start.')).toBeVisible({ timeout: 15_000 });
    await bar.getByRole('button', { name: 'Pause' }).click();
    await expect(bar).toContainText('Paused');
    await expect(bar.getByRole('button', { name: 'Confirm plan' })).toBeHidden();
    await expect(page.getByText('Goal paused by the owner')).toBeVisible();

    // A paused goal starts no turn, even for the owner's message.
    await page.getByRole('textbox', { name: /^Message / }).fill('Any news?');
    await page.keyboard.press('Control+Enter');
    await expect(page.getByText(/is paused; resume it first/)).toBeVisible();
    // That refusal is the expected 409.
    problems = problems.filter((p) => !p.includes('409 (Conflict)'));

    await bar.getByRole('button', { name: 'Resume' }).click();
    await expect(bar.getByRole('button', { name: 'Confirm plan' })).toBeVisible();
    await expect(page.getByText('Goal resumed by the owner.')).toBeVisible();
  });
});
