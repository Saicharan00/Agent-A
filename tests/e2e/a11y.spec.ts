import AxeBuilder from '@axe-core/playwright';
import { closeDb, createRepos, openDb } from '@agenta/db';
import { expect, test } from '@playwright/test';
import type { BotView } from '../../packages/shared/src/index';

// Accessibility (F33): axe-core's WCAG 2.x A/AA rules on every page, in the light and the dark theme.

// An unread notification, so the bell's badge is always on the page being scanned.
test.beforeAll(() => {
  const db = openDb('data/e2e/agenta.db');
  try {
    createRepos(db).notifications.create({ kind: 'test', title: 'a11y check' });
  } finally {
    closeDb(db);
  }
});

const ROUTES = [
  '/',
  '/bots',
  '/bots/new',
  '/tasks',
  '/learn',
  '/schedules',
  '/usage',
  '/settings',
  '/notifications',
  '/knowledge',
];

for (const scheme of ['light', 'dark'] as const) {
  test(`no WCAG A/AA violations on any page (${scheme})`, async ({ page, request }) => {
    test.setTimeout(120_000);
    // The app's theme is its own setting (localStorage wins over the cookie), not the system colour scheme.
    await page.addInitScript((t) => localStorage.setItem('agenta.theme', t), scheme);
    const bots = (await (await request.get('/api/bots')).json()) as BotView[];
    const routes = [...ROUTES, ...(bots[0]?.dmThreadId ? [`/threads/${bots[0].dmThreadId}`] : [])];
    const found: string[] = [];
    for (const path of routes) {
      await page.goto(path);
      await page.locator('main h1').first().waitFor();
      if (scheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/);
      else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
      // The unread count loads after the page: scan Home only once the bell's badge is there.
      if (path === '/') await expect(page.getByTestId('notifications-bell')).toHaveAccessibleName(/unread/);
      const { violations, incomplete } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      for (const v of violations)
        found.push(
          `${path} ${v.id} (${v.impact}): ${v.help} — ${v.nodes
            .slice(0, 3)
            .map((n) => n.target.join(' '))
            .join(' | ')}`,
        );
      // axe calls very short text (a "6" badge) "incomplete" even when it measured a failing ratio.
      for (const n of incomplete.find((v) => v.id === 'color-contrast')?.nodes ?? []) {
        const d = n.any[0]?.data as { contrastRatio?: number; expectedContrastRatio?: string } | undefined;
        const need = parseFloat(d?.expectedContrastRatio ?? '');
        if (d?.contrastRatio && need && d.contrastRatio < need)
          found.push(`${path} color-contrast ${d.contrastRatio}:1 — ${n.target.join(' ')}`);
      }
    }
    expect(found).toEqual([]);
  });
}

test('keyboard: every tab stop on Home is visible and shows a focus ring', async ({ page }) => {
  await page.goto('/');
  await page.locator('main h1').first().waitFor();
  const seen = new Set<string>();
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const ring =
        (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) ||
        (s.boxShadow !== 'none' && s.boxShadow !== '');
      const name = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40);
      return { name: `${el.tagName} "${name}"`, ring, visible: r.width > 0 && r.height > 0 };
    });
    if (!stop) continue;
    seen.add(stop.name);
    expect(stop.visible, `${stop.name} is visible`).toBe(true);
    expect(stop.ring, `${stop.name} shows focus`).toBe(true);
  }
  expect(seen.size).toBeGreaterThan(10);
});
