import { existsSync, readFileSync } from 'node:fs';
import { closeDb, createRepos, openDb } from '@agenta/db';
import { expect, type Page, test } from '@playwright/test';
import type { DecisionView, LessonView } from '../../packages/shared/src/index';

// Learn area (F23 session 1) against the mock engine; exported decisions land in data/e2e/shared (playwright.config.ts).

function trackConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Makes a lesson due now (a new one is first due tomorrow). */
function makeDue(id: string): void {
  const db = openDb('data/e2e/agenta.db');
  try {
    createRepos(db).lessons.update(id, { nextReviewAt: new Date(Date.now() - 60_000).toISOString() });
  } finally {
    closeDb(db);
  }
}

test.describe('learn', () => {
  let problems: string[];
  test.beforeEach(async ({ page }) => {
    problems = trackConsole(page);
  });
  test.afterEach(() => {
    expect(problems, 'console errors/warnings').toEqual([]);
  });

  test('record a decision: listed with its ADR number, status editable, exported to /shared/decisions', async ({
    page,
    request,
  }) => {
    const title = `Use SQLite ${uid()}`;
    await page.goto('/learn');
    await page.getByRole('button', { name: 'Record decision' }).click();
    const dialog = page.getByRole('dialog', { name: 'Record decision' });
    await dialog.getByLabel('Title').fill(title);
    await dialog.getByLabel('Context').fill('One owner, one laptop.');
    await dialog.getByLabel('Options considered').fill('- SQLite\n- Postgres');
    await dialog
      .getByRole('textbox', { name: 'Decision', exact: true })
      .fill('SQLite: **no server** to run.');
    await dialog.getByRole('button', { name: 'Record' }).click();
    await expect(dialog).toBeHidden();

    const detail = page.getByRole('article', { name: title });
    await expect(detail.getByRole('heading', { name: title })).toBeVisible();
    await expect(detail.getByText('no server')).toBeVisible();
    const d = ((await (await request.get('/api/decisions')).json()) as DecisionView[]).find(
      (x) => x.title === title,
    )!;
    await expect(detail).toContainText(`ADR-${String(d.number).padStart(4, '0')}`);
    await expect(detail).toContainText(d.path);
    const file = `data/e2e${d.path}`;
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('## Decision\n\nSQLite: **no server** to run.');

    await detail.getByLabel('Decision status').selectOption('accepted');
    await expect.poll(() => readFileSync(file, 'utf8')).toContain('- Status: accepted');
    await page.getByLabel('Filter by status').selectOption('accepted');
    await expect(page.getByRole('list', { name: 'Decision list' })).toContainText(title);
  });

  test('add a lesson, review it: "got it" pushes the next review out, "review again" brings it back tomorrow', async ({
    page,
    request,
  }) => {
    const topic = `testing-${uid()}`;
    await page.goto('/learn');
    await page.getByRole('tab', { name: 'Lessons' }).click();
    await page.getByRole('button', { name: 'Add lesson' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add lesson' });
    await dialog.getByLabel('Topic').fill(topic);
    await dialog.getByRole('textbox', { name: 'Lesson', exact: true }).fill('Test the edges first.');
    await dialog.getByLabel('Why it matters').fill('Bugs live at boundaries.');
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(dialog).toBeHidden();

    const all = page.getByRole('region', { name: 'All lessons' });
    await expect(all.getByRole('listitem', { name: topic })).toContainText('Bugs live at boundaries.');
    const lesson = ((await (await request.get('/api/lessons')).json()) as LessonView[]).find(
      (l) => l.topic === topic,
    )!;
    const day = 86_400_000;
    expect(Date.parse(lesson.nextReviewAt!) - Date.now()).toBeGreaterThan(day - 120_000);

    makeDue(lesson.id);
    await page.reload();
    await page.getByRole('tab', { name: 'Lessons' }).click();
    const due = page.getByRole('region', { name: 'Due for review' }).getByRole('listitem', { name: topic });
    await due.getByRole('button', { name: 'Got it' }).click();
    await expect(due).toBeHidden();
    const after = async () =>
      ((await (await request.get('/api/lessons')).json()) as LessonView[]).find((l) => l.id === lesson.id)!;
    let l = await after();
    expect(l.reviewedCount).toBe(1);
    expect(Date.parse(l.nextReviewAt!) - Date.now()).toBeGreaterThan(day - 120_000);
    await expect(all.getByRole('listitem', { name: topic })).toContainText('reviewed 1×');

    makeDue(lesson.id);
    await page.reload();
    await page.getByRole('tab', { name: 'Lessons' }).click();
    await page
      .getByRole('region', { name: 'Due for review' })
      .getByRole('listitem', { name: topic })
      .getByRole('button', { name: 'Got it' })
      .click();
    l = await after();
    // Second "got it": 3 days.
    expect(Date.parse(l.nextReviewAt!) - Date.now()).toBeGreaterThan(3 * day - 120_000);

    makeDue(lesson.id);
    await page.reload();
    await page.getByRole('tab', { name: 'Lessons' }).click();
    await page
      .getByRole('region', { name: 'Due for review' })
      .getByRole('listitem', { name: topic })
      .getByRole('button', { name: 'Review again' })
      .click();
    await expect.poll(async () => (await after()).reviewedCount).toBe(0);
    l = await after();
    expect(Date.parse(l.nextReviewAt!) - Date.now()).toBeLessThan(day + 120_000);
  });
});
