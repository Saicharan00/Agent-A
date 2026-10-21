import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import type { BotView, TaskDetail } from '../../packages/shared/src/index';

// Task board (F19) against the mock engine (playwright.config.ts forces AGENTA_ENGINE_OVERRIDE=mock).

function trackConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function createBot(request: APIRequestContext, name: string): Promise<BotView> {
  const res = await request.post('/api/bots', { data: { name: `${name} ${uid()}`, engine: 'mock' } });
  expect(res.status()).toBe(201);
  return (await res.json()) as BotView;
}

const column = (page: Page, status: string) =>
  page.locator(`[data-testid="task-column"][data-status="${status}"]`);

test.describe('task board', () => {
  let problems: string[];
  test.beforeEach(async ({ page }) => {
    problems = trackConsole(page);
  });
  test.afterEach(() => {
    expect(problems, 'console errors/warnings').toEqual([]);
  });

  test('create → assign to a mock bot → in progress → mock hands in → in review', async ({
    page,
    request,
  }) => {
    const bot = await createBot(request, 'Builder');
    const title = `Landing page ${uid()}`;
    await page.goto('/tasks');

    await page.getByRole('button', { name: 'New task' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New task' });
    await dialog.getByLabel('Title').fill(title);
    await dialog.getByLabel('Description').fill('Build it [mock:task]');
    await dialog.getByLabel('Acceptance criteria').fill('- renders');
    await dialog.getByRole('button', { name: 'Create task' }).click();
    await expect(dialog).toBeHidden();

    const card = page.getByTestId('task-card').filter({ hasText: title });
    await expect(column(page, 'todo').getByTestId('task-card').filter({ hasText: title })).toBeVisible();

    // Assigning in the drawer starts it.
    await card.click();
    const drawer = page.getByTestId('task-drawer');
    await expect(drawer.getByRole('heading', { name: title })).toBeVisible();
    await drawer.getByLabel('Assignee').selectOption(bot.id);
    // The mock runs fast, so the card may pass In progress quickly; the timeline proves it was started.
    await expect(drawer.getByTestId('task-timeline')).toContainText(`You started ${bot.name}'s turn`);
    await expect(drawer.getByTestId('task-timeline')).toContainText('moved it to In progress');

    // Live: the mock's submit_task_result moves it to In review without a reload.
    await expect(column(page, 'in_review').getByTestId('task-card').filter({ hasText: title })).toBeVisible({
      timeout: 15_000,
    });
    await expect(drawer.getByTestId('task-result')).toContainText('Done by the mock engine.');
    await expect(drawer.getByText('/shared/mock-result.md')).toBeVisible();
    await expect(drawer.getByTestId('task-timeline')).toContainText(`${bot.name} handed in the result`);

    // The task thread shows the turn.
    await drawer.getByRole('link', { name: 'Task thread' }).click();
    await expect(page).toHaveURL(/\/threads\/thr_/);
    await expect(page.getByText('Handed in for review.')).toBeVisible();
  });

  test('drag & drop changes status and persists; list view and filters', async ({ page, request }) => {
    // Wide enough for all six columns: a drag that has to scroll the board first would grab another card.
    await page.setViewportSize({ width: 1600, height: 900 });
    const title = `Drag me ${uid()}`;
    const res = await request.post('/api/tasks', { data: { title, priority: 'p1' } });
    expect(res.status()).toBe(201);
    const task = (await res.json()) as TaskDetail;
    await page.goto('/tasks');

    const card = column(page, 'todo').getByTestId('task-card').filter({ hasText: title });
    await card.dragTo(column(page, 'blocked').getByRole('heading'));
    await expect(column(page, 'blocked').getByTestId('task-card').filter({ hasText: title })).toBeVisible();
    await expect
      .poll(async () => ((await (await request.get(`/api/tasks/${task.id}`)).json()) as TaskDetail).status)
      .toBe('blocked');

    await page.reload();
    await expect(column(page, 'blocked').getByTestId('task-card').filter({ hasText: title })).toBeVisible();

    await page.getByRole('button', { name: 'List' }).click();
    await expect(page.getByTestId('task-list').getByRole('row').filter({ hasText: title })).toContainText(
      'Blocked',
    );
    await page.getByLabel('Priority').selectOption('p3');
    await expect(page.getByTestId('task-list').getByText(title)).toBeHidden();
  });

  test('delete in the drawer removes the task and its sub-task after a confirm', async ({
    page,
    request,
  }) => {
    const title = `Throwaway ${uid()}`;
    const parent = (await (await request.post('/api/tasks', { data: { title } })).json()) as TaskDetail;
    const child = (await (
      await request.post('/api/tasks', { data: { title: `${title} child`, parentTaskId: parent.id } })
    ).json()) as TaskDetail;

    await page.goto('/tasks');
    await column(page, 'todo')
      .getByTestId('task-card')
      .filter({ has: page.getByText(title, { exact: true }) })
      .click();
    const drawer = page.getByTestId('task-drawer');
    await expect(drawer.getByRole('heading', { name: title, exact: true })).toBeVisible();
    page.once('dialog', (d) => {
      expect(d.message()).toBe(`Delete the task "${title}" and its 1 sub-task? Running turns are stopped.`);
      void d.accept();
    });
    await drawer.getByRole('button', { name: 'Delete' }).click();

    await expect(drawer).toBeHidden();
    await expect(page.getByTestId('task-card').filter({ hasText: title })).toHaveCount(0);
    expect((await request.get(`/api/tasks/${parent.id}`)).status()).toBe(404);
    expect((await request.get(`/api/tasks/${child.id}`)).status()).toBe(404);
  });
});
