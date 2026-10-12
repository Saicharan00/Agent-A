import { expect, type Page, test } from '@playwright/test';

const ROUTES: { path: string; heading: string }[] = [
  { path: '/', heading: 'Agent A' },
  { path: '/bots', heading: 'Bots' },
  { path: '/bots/new', heading: 'New bot' },
  { path: '/bots/bot_demo', heading: 'Bot' },
  { path: '/threads/thr_demo', heading: 'Thread' },
  { path: '/tasks', heading: 'Tasks' },
  { path: '/learn', heading: 'Learn' },
  { path: '/schedules', heading: 'Schedules' },
  { path: '/usage', heading: 'Usage' },
  { path: '/settings', heading: 'Settings' },
];

/** Collects console errors/warnings and uncaught exceptions; asserted empty after each test. */
function trackConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

const h1 = (page: Page) => page.locator('main h1');

test.describe('app shell', () => {
  let problems: string[];
  test.beforeEach(async ({ page }) => {
    problems = trackConsole(page);
  });
  test.afterEach(() => {
    expect(problems, 'console errors/warnings').toEqual([]);
  });

  test('every route renders inside the shell', async ({ page }) => {
    for (const { path, heading } of ROUTES) {
      await page.goto(path);
      await expect(h1(page), path).toHaveText(heading);
      await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible();
      await expect(page.getByTestId('runner-status')).toHaveText('Runner: ok');
    }
  });

  test('sidebar links navigate and mark the active page', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Main' });
    for (const label of ['Bots', 'Tasks', 'Learn', 'Schedules', 'Usage', 'Settings', 'Home']) {
      await nav.getByRole('link', { name: label, exact: true }).click();
      await expect(h1(page)).toHaveText(label === 'Home' ? 'Agent A' : label);
      await expect(nav.getByRole('link', { name: label, exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
    }
  });

  test('sidebar collapses and the choice persists', async ({ page }) => {
    await page.goto('/');
    const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(sidebar).toHaveAttribute('data-collapsed', 'true');
    // Width animates (200ms), so poll rather than measure once.
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(80);
    await page.reload();
    await expect(sidebar).toHaveAttribute('data-collapsed', 'true');
    await page.keyboard.press('Control+b');
    await expect(sidebar).toHaveAttribute('data-collapsed', 'false');
  });

  test('theme toggles and persists across reloads', async ({ page }) => {
    await page.goto('/');
    const html = page.locator('html');
    await expect(html).toHaveClass(/\bdark\b/);
    await page.getByTestId('theme-toggle').click();
    await expect(html).not.toHaveClass(/\bdark\b/);
    expect(await page.evaluate(() => localStorage.getItem('agenta.theme'))).toBe('light');
    // The server renders the saved theme (via cookie), so there is no dark flash before hydration.
    const ssr = await (await page.request.get('/')).text();
    expect(ssr).toMatch(/<html lang="en" style="color-scheme:light">/);
    await page.reload();
    await expect(html).not.toHaveClass(/\bdark\b/);
    await page.getByTestId('theme-toggle').click();
    await expect(html).toHaveClass(/\bdark\b/);
  });

  test('computer panel opens, switches tabs and closes', async ({ page }) => {
    await page.goto('/');
    const panel = page.getByRole('complementary', { name: 'Computer' });
    await expect(panel).toHaveCount(0);
    await page.getByRole('button', { name: 'Open computer panel' }).click();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
    await panel.getByRole('tab', { name: 'Files' }).click();
    await expect(panel.getByRole('tabpanel')).toContainText('Files not connected');
    await page.keyboard.press('ArrowRight');
    await expect(panel.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true');
    await panel.getByRole('button', { name: 'Close computer panel' }).click();
    await expect(panel).toHaveCount(0);
    await page.keyboard.press('Control+\\');
    await expect(panel).toBeVisible();
    await page.keyboard.press('Control+\\');
    await expect(panel).toHaveCount(0);
  });

  test('Ctrl+K palette opens, navigates and closes', async ({ page }) => {
    await page.goto('/');
    const dialog = page.getByRole('dialog');
    await page.keyboard.press('Control+k');
    await expect(dialog).toBeVisible();
    await page.keyboard.type('sched');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/schedules$/);

    await page.getByRole('button', { name: 'Search and commands' }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.keyboard.press('Control+k');
    await page.keyboard.type('light theme');
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
  });

  for (const width of [1280, 1920]) {
    test(`layout is usable at ${width}px with every panel open`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/tasks');
      await page.getByRole('button', { name: 'Open computer panel' }).click();
      const sidebar = await page.getByRole('complementary', { name: 'Sidebar' }).boundingBox();
      const main = await page.locator('main').boundingBox();
      const panel = await page.getByRole('complementary', { name: 'Computer' }).boundingBox();
      expect(sidebar!.width).toBeGreaterThanOrEqual(240);
      expect(main!.width).toBeGreaterThanOrEqual(560);
      expect(panel!.width).toBeGreaterThanOrEqual(380);
      expect(sidebar!.x + sidebar!.width).toBeLessThanOrEqual(main!.x + 1);
      expect(main!.x + main!.width).toBeLessThanOrEqual(panel!.x + 1);
      expect(panel!.x + panel!.width).toBeLessThanOrEqual(width);
      const search = await page.getByRole('button', { name: 'Search and commands' }).boundingBox();
      expect(search!.width).toBeGreaterThanOrEqual(160);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});
