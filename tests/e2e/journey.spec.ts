import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { closeDb, createRepos, openDb } from '@agenta/db';
import { type BotView, ONBOARDING_HELLO } from '../../packages/shared/src/index';

// The whole product in one sitting (F33), against the mock engine: onboarding → chat → tools → computer tabs → group →
// goal delegation loop → approvals → learn → schedules → usage → backup. Each feature's own spec covers the details;
// this one proves they work together, on the team the wizard creates.

function trackConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Empties the shared e2e DB of bots, so the app looks freshly installed. The lead can't be deleted, so demote it first. */
async function deleteAllBots(request: APIRequestContext): Promise<void> {
  const bots = (await (await request.get('/api/bots?archived=include')).json()) as BotView[];
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

async function send(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: /^Message / });
  await box.fill(text);
  await box.press('Control+Enter');
  await expect(box).toHaveValue('');
}

const terminal = (page: Page) => page.locator('[data-testid="terminal"]:visible');

test('journey: onboarding → chat → computer → group → goal → approvals → learn → schedules → usage → backup', async ({
  page,
  request,
}) => {
  test.setTimeout(480_000);
  const problems = trackConsole(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  let team: BotView[] = [];
  const bot = (name: string) => team.find((b) => b.name === name)!;

  await test.step('onboarding: the wizard creates the team and greets Agent A', async () => {
    await deleteAllBots(request);
    await page.goto('/');
    await page.getByTestId('onboarding').getByRole('button', { name: 'Create the team' }).click();
    await expect(page).toHaveURL(/\/threads\/thr_/);
    await expect(page.getByText(`You said: ${ONBOARDING_HELLO}`)).toBeVisible();
    team = (await (await request.get('/api/bots')).json()) as BotView[];
    expect(team).toHaveLength(7);
  });

  await test.step('chat with tools: tool cards and a file chip in the lead DM', async () => {
    await send(page, '[mock:tools] tidy up');
    const turn = page.getByTestId('bot-turn').last();
    await expect(turn).toHaveAttribute('data-run-status', 'succeeded');
    await expect(turn.getByTestId('tool-card')).toHaveCount(2);
    await expect(turn.getByTestId('file-chip')).toHaveText('hello.txt');
  });

  const architect = () => bot('Architect');
  await test.step('computer tabs: terminal, files, desktop and runs on one bot', async () => {
    await page.goto('/bots');
    await page
      .getByRole('article', { name: architect().name })
      .getByRole('button', { name: 'Computer' })
      .click();
    const panel = page.getByRole('complementary', { name: 'Computer' });
    await panel.getByRole('button', { name: 'Open terminal' }).click();
    await expect(panel.locator('[data-testid="terminal-status"]:visible')).toHaveAttribute(
      'data-state',
      'open',
      {
        timeout: 150_000,
      },
    );
    await terminal(page).click();
    await page.keyboard.type(
      'echo journey-$((6*7)) > /home/bot/work/journey.txt && cat /home/bot/work/journey.txt',
    );
    await page.keyboard.press('Enter');
    await expect(terminal(page).locator('.xterm-rows')).toContainText('journey-42');

    // The file the shell wrote shows in Files.
    await panel.getByRole('tab', { name: 'Files' }).click();
    await expect(panel.getByRole('treeitem', { name: 'journey.txt', exact: true })).toBeVisible();

    await panel.getByRole('tab', { name: 'Desktop' }).click();
    await expect(panel.getByTestId('desktop-status')).toHaveAttribute('data-state', 'connected', {
      timeout: 60_000,
    });
    await panel.getByRole('tab', { name: 'Runs' }).click();
    await panel.getByRole('button', { name: 'Close computer panel' }).click();
    expect((await request.post(`/api/bots/${architect().id}/computer/stop`)).ok()).toBe(true);
  });

  await test.step('group: two @mentioned bots both reply', async () => {
    const title = `Journey ${uid()}`;
    const ml = bot('ML Engineer');
    await page.goto('/bots');
    await page.getByRole('button', { name: 'New group' }).click();
    const dialog = page.getByRole('dialog', { name: 'New group chat' });
    await dialog.getByLabel('Name').fill(title);
    await dialog.getByRole('checkbox', { name: `Add ${architect().name}` }).check();
    await dialog.getByRole('checkbox', { name: `Add ${ml.name}` }).check();
    await dialog.getByRole('button', { name: 'Create group' }).click();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await send(page, `@${architect().slug} and @${ml.slug} hello team`);
    // A turn quotes the whole message, so both turns mention both names: who ran comes from the API.
    const turns = page.getByTestId('bot-turn');
    await expect(turns).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      await expect(turns.nth(i)).toHaveAttribute('data-run-status', 'succeeded');
      await expect(turns.nth(i).getByTestId('turn-text')).toContainText('You said:');
    }
    const threadId = /\/threads\/(thr_[^/?#]+)/.exec(page.url())![1];
    const runs = (await (await request.get(`/api/runs?threadId=${threadId}`)).json()) as { botId: string }[];
    expect(runs.map((r) => r.botId).sort()).toEqual([architect().id, ml.id].sort());
  });

  await test.step('goal: Agent A plans, delegates, reviews and reports', async () => {
    await page.goto('/');
    const form = page.getByRole('form', { name: 'New goal' });
    await form.getByLabel('Goal').fill(`Journey goal ${uid()} [mock:plan]`);
    await form.getByRole('button', { name: 'Start goal' }).click();
    const bar = page.getByTestId('goal-bar');
    await expect(page.getByText('Confirm the plan to start.')).toBeVisible({ timeout: 15_000 });
    await bar.getByRole('button', { name: 'Confirm plan' }).click();
    await expect(bar).toContainText('Done', { timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Goal report' })).toBeVisible();
  });

  await test.step('approvals: a bot asks, the owner approves from Home', async () => {
    await page.goto(`/threads/${architect().dmThreadId}`);
    await send(page, 'Push it [mock:approval]');
    await expect(page.getByText('I asked for your approval before pushing.')).toBeVisible();
    await page.goto('/');
    const card = page
      .getByRole('region', { name: /Waiting for your approval/ })
      .getByRole('listitem', { name: `${architect().name} asks to: Push to origin/main` });
    await card.getByRole('button', { name: 'Approve' }).click();
    await expect(card).toHaveCount(0);
  });

  await test.step('learn: record a decision', async () => {
    const title = `Journey decision ${uid()}`;
    await page.goto('/learn');
    await page.getByRole('button', { name: 'Record decision' }).click();
    const dialog = page.getByRole('dialog', { name: 'Record decision' });
    await dialog.getByLabel('Title').fill(title);
    await dialog.getByLabel('Context').fill('End-to-end check.');
    await dialog.getByRole('textbox', { name: 'Decision', exact: true }).fill('Keep the journey green.');
    await dialog.getByRole('button', { name: 'Record' }).click();
    await expect(page.getByRole('article', { name: title })).toBeVisible();
  });

  await test.step('schedules: create one and run it now', async () => {
    const name = `Journey check ${uid()}`;
    await page.goto('/schedules');
    await page.getByRole('button', { name: 'New schedule' }).click();
    const form = page.getByRole('form', { name: 'New schedule' });
    await form.getByLabel('Name').fill(name);
    await form.getByLabel('Bot').selectOption({ label: architect().name });
    await form.getByLabel('Prompt').fill('Journey status');
    await form.getByRole('button', { name: 'Create schedule' }).click();
    await page
      .getByRole('listitem', { name: `Schedule ${name}` })
      .getByRole('button', { name: 'Run now' })
      .click();
    await expect(page).toHaveURL(/\/threads\/thr_/);
    const turn = page.getByTestId('bot-turn').last();
    await expect(turn).toHaveAttribute('data-run-status', 'succeeded');
    await expect(turn.getByTestId('turn-text')).toContainText('Journey status');
  });

  await test.step('usage: the runs of this journey are counted', async () => {
    await page.goto('/usage');
    const row = page
      .getByRole('region', { name: 'Bots' })
      .getByRole('row', { name: new RegExp(architect().name) });
    await expect(row).toBeVisible();
  });

  await test.step('backup: back up now', async () => {
    await page.goto('/settings');
    const section = page.getByRole('region', { name: 'Backups' });
    await section.getByRole('button', { name: 'Back up now' }).click();
    await expect(page.getByText('Backup written')).toBeVisible();
    await expect(section.getByTestId('backup-row').first()).toContainText('manual');
  });

  expect(problems, 'console errors/warnings').toEqual([]);
});
