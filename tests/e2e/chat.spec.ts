import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { closeDb, createRepos, openDb } from '../../packages/db/src/index';
import type { BotView } from '../../packages/shared/src/index';

// Direct chat (F13) against the mock engine (playwright.config.ts forces AGENTA_ENGINE_OVERRIDE=mock).
const dbPath = resolve('data/e2e/agenta.db');
const botsDir = resolve('data/e2e/bots');

function trackConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function createBot(request: APIRequestContext): Promise<BotView & { dmThreadId: string }> {
  const res = await request.post('/api/bots', { data: { name: `Chat Bot ${uid()}`, engine: 'mock' } });
  expect(res.status()).toBe(201);
  return (await res.json()) as BotView & { dmThreadId: string };
}

async function send(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: /^Message / });
  await box.fill(text);
  await box.press('Control+Enter');
  await expect(box).toHaveValue('');
}

const lastTurn = (page: Page) => page.getByTestId('bot-turn').last();

test.describe('direct chat', () => {
  let problems: string[];
  test.beforeEach(async ({ page }) => {
    problems = trackConsole(page);
  });
  test.afterEach(() => {
    expect(problems, 'console errors/warnings').toEqual([]);
  });

  test('[mock:hello] streams into a pending reply, then settles', async ({ page, request }) => {
    const bot = await createBot(request);
    await page.goto(`/threads/${bot.dmThreadId}`);
    await expect(page.getByRole('heading', { level: 1, name: bot.name })).toBeVisible();
    await expect(page.getByText(`Start a conversation with ${bot.name}`)).toBeVisible();

    // Record every text the reply shows while it streams.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { __seen: string[] }).__seen = seen;
      new MutationObserver(() => {
        const turn = document.querySelector('[data-testid="bot-turn"] [data-testid="turn-text"]');
        if (turn?.textContent) seen.push(turn.textContent);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });

    await send(page, '[mock:hello] hi there');
    await expect(page.getByTestId('message-user').last()).toContainText('[mock:hello] hi there');
    const final = `Hello! I'm ${bot.name}, running on the mock engine. How can I help?`;
    await expect(lastTurn(page)).toHaveAttribute('data-run-status', 'succeeded');
    await expect(lastTurn(page)).toContainText(final);
    await expect(lastTurn(page).getByTestId('typing-indicator')).toHaveCount(0);

    // It streamed: the reply grew through partial texts before reaching the final one.
    const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
    const partial = seen.filter((s) => s.length > 0 && s.length < final.length && final.startsWith(s.trim()));
    expect(partial.length).toBeGreaterThan(2);

    // The reply is stored: still there after a reload, exactly once.
    await page.reload();
    await expect(page.getByText(final)).toHaveCount(1);
  });

  test('Stop on [mock:slow] cancels the run; a reload mid-run shows the transcript so far', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const bot = await createBot(request);
    await page.goto(`/threads/${bot.dmThreadId}`);
    await send(page, '[mock:slow] take your time');

    const turn = lastTurn(page);
    await expect(turn).toHaveAttribute('data-run-status', 'running', { timeout: 10_000 });
    await expect(turn.getByTestId('typing-indicator')).toBeVisible();
    await expect(turn).toContainText('Working slowly...', { timeout: 10_000 });

    // Reload mid-run: the run channel replays everything streamed so far, then keeps streaming.
    await page.reload();
    const again = lastTurn(page);
    await expect(again).toHaveAttribute('data-run-status', 'running');
    await expect(again).toContainText('Working slowly...');
    await expect(again).toContainText('Working slowly....', { timeout: 5000 });

    await page.getByTestId('composer-stop').click();
    await expect(again).toHaveAttribute('data-run-status', 'cancelled', { timeout: 15_000 });
    await expect(again.getByTestId('run-state')).toHaveText('Stopped');
    await expect(page.getByTestId('composer-stop')).toHaveCount(0);
    // The partial reply of a stopped turn is never stored as a message, but its timeline is: it survives a reload.
    await page.reload();
    await expect(lastTurn(page)).toContainText('Working slowly...');
    await expect(lastTurn(page).getByTestId('run-state')).toHaveText('Stopped');
    const runs = (await (await request.get(`/api/runs?threadId=${bot.dmThreadId}`)).json()) as {
      status: string;
    }[];
    expect(runs.map((r) => r.status)).toEqual(['cancelled']);
  });

  test('[mock:limit] shows the limited state and the queued retry', async ({ page, request }) => {
    test.setTimeout(60_000);
    const db = openDb(dbPath);
    const repos = createRepos(db);
    repos.engineState.clearLimit('mock'); // another spec may have left a pause behind
    const bot = await createBot(request);
    try {
      await page.goto(`/threads/${bot.dmThreadId}`);
      await send(page, '[mock:limit] please');
      const turns = page.getByTestId('bot-turn');
      await expect(turns.first()).toHaveAttribute('data-run-status', 'limited', { timeout: 15_000 });
      await expect(turns.first().getByTestId('run-state')).toHaveText(
        /^Usage limit reached — this turn runs again at \d{2}:\d{2}$/,
      );
      // The automatic retry waits in the queue until the reset.
      await expect(turns).toHaveCount(2);
      await expect(turns.nth(1)).toHaveAttribute('data-run-status', 'queued');
      await expect(turns.nth(1).getByTestId('run-state')).toContainText(/^Limited — resumes at \d{2}:\d{2}/);
      // Cancel it from the chat.
      await turns.nth(1).getByRole('button', { name: 'Cancel' }).click();
      await expect(turns.nth(1)).toHaveAttribute('data-run-status', 'cancelled');
    } finally {
      for (const r of repos.runs.list({ botId: bot.id, status: 'queued' }))
        await request.post(`/api/runs/${r.id}/cancel`);
      repos.engineState.clearLimit('mock');
      closeDb(db);
    }
  });

  test('an attachment lands in the bot inbox and is referenced in the message', async ({ page, request }) => {
    const bot = await createBot(request);
    await page.goto(`/threads/${bot.dmThreadId}`);
    await expect(page.getByRole('button', { name: 'Attach files' })).toBeEnabled();
    await page.getByTestId('attach-input').setInputFiles({
      name: 'brief notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Brief\nShip it.\n'),
    });
    const chip = page.getByTestId('attachment-chip');
    await expect(chip).toHaveAttribute('data-state', 'done');
    await expect(chip).toContainText('brief notes.md');

    const file = resolve(botsDir, bot.id, 'home', 'work', 'inbox', 'brief notes.md');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('# Brief\nShip it.\n');

    await send(page, 'Please read this');
    await expect(chip).toHaveCount(0);
    const userMsg = page.getByTestId('message-user').last();
    await expect(userMsg).toContainText('Please read this');
    await expect(userMsg).toContainText('inbox/brief notes.md');
    // The echo reply proves the bot got the inbox path in its prompt.
    await expect(lastTurn(page)).toContainText('/home/bot/work/inbox/brief notes.md');
  });

  test('a code block is highlighted and can be copied', async ({ page, request, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const bot = await createBot(request);
    await page.goto(`/threads/${bot.dmThreadId}`);
    await send(page, 'Run this:\n\n```ts\nconst answer = 42;\n```');
    const block = page.getByTestId('message-user').last().getByTestId('code-block');
    await expect(block).toContainText('const answer = 42;');
    await expect(block.locator('.shiki')).toBeVisible(); // shiki loaded
    await block.getByRole('button', { name: 'Copy code' }).click();
    await expect(block.getByRole('button', { name: 'Copy code' })).toContainText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('const answer = 42;');
  });

  test('[mock:tools] renders tool cards, a diff, file chips and a footer; all survive a reload', async ({
    page,
    request,
  }) => {
    const bot = await createBot(request);
    await page.goto(`/threads/${bot.dmThreadId}`);
    await send(page, '[mock:tools] tidy up');
    const turn = lastTurn(page);
    await expect(turn).toHaveAttribute('data-run-status', 'succeeded');

    for (const pass of ['live', 'stored']) {
      const cards = turn.getByTestId('tool-card');
      await expect(cards, pass).toHaveCount(2);
      await expect(cards.nth(0)).toContainText('Ran a command');
      await expect(cards.nth(0)).toContainText('ls -la /home/bot/work');
      await expect(cards.nth(1)).toContainText('Wrote a file');
      await expect(turn.getByTestId('thinking')).toContainText('Thinking');
      // Text before and after the tools, in order.
      const texts = turn.getByTestId('turn-text');
      await expect(texts.first()).toContainText('Let me check the workspace first.');
      await expect(texts.last()).toContainText('created hello.txt');
      await expect(turn.getByTestId('run-footer')).toContainText(/Mock · \d+ (ms|s) · \d+ in · \d+ out/);

      await cards.nth(0).locator('summary').click();
      await expect(cards.nth(0).getByTestId('tool-output')).toContainText('drwxr-xr-x');
      await cards.nth(1).locator('summary').click();
      await expect(cards.nth(1).getByTestId('tool-diff')).toContainText('hello from mock');

      const chip = turn.getByTestId('file-chip');
      await expect(chip).toHaveText('hello.txt');
      await expect(chip).toHaveAttribute('data-change', 'created');
      if (pass === 'live') await page.reload();
    }

    // A file chip opens the bot's computer on the Files tab at that path. The mock engine only reports the write,
    // so put the file on disk the way a real engine would have.
    const put = await request.post(`/api/bots/${bot.id}/files/upload?root=home&path=work&name=hello.txt`, {
      headers: { 'content-type': 'application/octet-stream' },
      data: Buffer.from('hello from mock\n'),
    });
    expect([201, 409]).toContain(put.status());
    await lastTurn(page).getByTestId('file-chip').click();
    await expect(page.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('computer-file-path')).toHaveText('/home/bot/work/hello.txt');
    await expect(page.getByTestId('file-viewer').locator('.view-lines')).toContainText('hello from mock');
    await expect(page.getByTestId('computer-bot')).toContainText(bot.name);
  });

  test('retry the last turn, copy a reply, edit and resend the last message', async ({
    page,
    request,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const bot = await createBot(request);
    await page.goto(`/threads/${bot.dmThreadId}`);
    await send(page, '[mock:error] break');
    const turns = page.getByTestId('bot-turn');
    await expect(turns.first()).toHaveAttribute('data-run-status', 'failed');
    await expect(turns.first().getByTestId('turn-error')).toContainText('Mock engine failure');
    await expect(turns.first().getByTestId('run-state')).toHaveText('Failed');

    await turns.first().getByTestId('retry-turn').click();
    await expect(turns).toHaveCount(2);
    await expect(turns.nth(1)).toHaveAttribute('data-run-status', 'failed');
    // Only the latest turn offers Retry.
    await expect(turns.first().getByTestId('retry-turn')).toHaveCount(0);
    await expect(turns.nth(1).getByTestId('retry-turn')).toBeVisible();
    // Both turns sit under the one user message.
    await expect(page.getByTestId('message-user')).toHaveCount(1);

    await send(page, 'first draft');
    const reply = lastTurn(page);
    await expect(reply).toContainText('You said: first draft');
    await reply.hover();
    await reply.getByTestId('copy-message').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('You said: first draft');

    const lastUser = page.getByTestId('message-user').last();
    await lastUser.hover();
    await lastUser.getByRole('button', { name: 'Edit and resend' }).click();
    const box = page.getByRole('textbox', { name: /^Message / });
    await expect(page.getByTestId('editing-banner')).toBeVisible();
    await expect(box).toHaveValue('first draft');
    await box.fill('second draft');
    await box.press('Control+Enter');
    await expect(page.getByTestId('editing-banner')).toHaveCount(0);
    await expect(lastTurn(page)).toContainText('You said: second draft');
    // The older message can no longer be edited.
    await expect(page.getByRole('button', { name: 'Edit and resend' })).toHaveCount(1);
  });

  test('Explain mode is stored on the thread and reaches the bot', async ({ page, request }) => {
    const bot = await createBot(request);
    await page.goto(`/threads/${bot.dmThreadId}`);
    const toggle = page.getByRole('button', { name: 'Explain' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Explain' })).toHaveAttribute('aria-pressed', 'true');
    // The mock echoes its prompt: the explain instructions are in it.
    await send(page, 'teach me');
    await expect(lastTurn(page)).toContainText('Explain mode is on');
  });

  test('unread replies show a sidebar badge until the chat is opened', async ({ page, request }) => {
    const bot = await createBot(request);
    await page.goto('/bots');
    const link = page.getByRole('list', { name: 'Bots' }).getByRole('link', { name: bot.name });
    await expect(link).toBeVisible();
    const res = await request.post(`/api/threads/${bot.dmThreadId}/messages`, {
      data: { content: '[mock:hello] ping' },
    });
    expect(res.status()).toBe(201);
    await expect(link.getByTestId('unread-badge')).toHaveText('1', { timeout: 10_000 });

    await link.click();
    await expect(lastTurn(page)).toContainText('Hello!');
    await expect(link.getByTestId('unread-badge')).toHaveCount(0);
    await page.goto('/bots');
    await expect(link).toBeVisible();
    await expect(link.getByTestId('unread-badge')).toHaveCount(0);
  });
});
