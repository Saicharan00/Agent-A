import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import type { BotView } from '../../packages/shared/src/index';

// Confidentiality guard (F24) against the mock engine (playwright.config.ts forces AGENTA_ENGINE_OVERRIDE=mock).

function trackConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    // A flagged upload is an expected 422 the browser logs as a failed resource.
    if (m.text().includes('status of 422')) return;
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function createBot(request: APIRequestContext): Promise<BotView> {
  const res = await request.post('/api/bots', { data: { name: `Guarded ${uid()}`, engine: 'mock' } });
  expect(res.status()).toBe(201);
  return (await res.json()) as BotView;
}

test.describe('confidentiality guard', () => {
  let problems: string[];
  // A unique term, deleted afterwards: the e2e DB is shared with the other specs.
  let term: string;
  test.beforeEach(async ({ page }) => {
    problems = trackConsole(page);
    term = `Zorblax${uid()}`;
  });
  test.afterEach(async ({ request }) => {
    const terms = (await (await request.get('/api/guard/terms')).json()) as { id: string; term: string }[];
    for (const t of terms.filter((x) => x.term === term)) await request.delete(`/api/guard/terms/${t.id}`);
    expect(problems, 'console errors/warnings').toEqual([]);
  });

  test('a guard term added in Settings triggers the modal; Edit keeps the text; Redact sends the redacted text', async ({
    page,
    request,
  }) => {
    await page.goto('/settings');
    const section = page.getByRole('region', { name: 'Confidentiality guard' });
    await section.getByLabel('Term').fill(term);
    await section.getByLabel('Note').fill('client');
    await section.getByRole('button', { name: 'Add term' }).click();
    await expect(section.getByRole('list', { name: 'Guard terms' })).toContainText(term);

    const bot = await createBot(request);
    await page.goto(`/threads/${bot.dmThreadId}`);
    const box = page.getByRole('textbox', { name: /^Message / });
    const message = `Draft the ${term} launch email to ops@example.org`;
    await box.fill(message);
    await box.press('Control+Enter');

    const dialog = page.getByRole('dialog', { name: 'This message looks confidential' });
    await expect(dialog).toBeVisible();
    const findings = dialog.getByTestId('guard-findings');
    await expect(findings).toContainText('guard term (client)');
    await expect(findings).toContainText(term);
    await expect(findings).toContainText('email address');

    // Edit: back to the composer, nothing sent.
    await dialog.getByRole('button', { name: 'Edit' }).click();
    await expect(dialog).toBeHidden();
    await expect(box).toHaveValue(message);
    await expect(page.getByTestId('message-user')).toHaveCount(0);

    await box.press('Control+Enter');
    await dialog.getByRole('button', { name: 'Redact automatically' }).click();
    await expect(dialog).toBeHidden();
    await expect(box).toHaveValue('');
    const sent = page.getByTestId('message-user').last();
    await expect(sent).toContainText('Draft the [REDACTED:guard_term] launch email to [REDACTED:email]');
    await expect(sent).not.toContainText(term);
  });

  test('Send anyway sends the original; a flagged attachment can be uploaded anyway', async ({
    page,
    request,
  }) => {
    expect((await request.post('/api/guard/terms', { data: { term } })).status()).toBe(201);
    const bot = await createBot(request);
    await page.goto(`/threads/${bot.dmThreadId}`);
    const box = page.getByRole('textbox', { name: /^Message / });
    await box.fill(`notes on ${term}`);
    await box.press('Control+Enter');
    const dialog = page.getByRole('dialog', { name: 'This message looks confidential' });
    await dialog.getByRole('button', { name: 'Send anyway' }).click();
    await expect(page.getByTestId('message-user').last()).toContainText(`notes on ${term}`);

    await page.getByTestId('attach-input').setInputFiles({
      name: 'plan.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(`${term} roadmap`),
    });
    const chip = page.getByTestId('attachment-chip');
    await expect(chip).toHaveAttribute('data-state', 'flagged');
    await chip.getByRole('button', { name: 'Upload anyway' }).click();
    await expect(chip).toHaveAttribute('data-state', 'done');
  });
});
