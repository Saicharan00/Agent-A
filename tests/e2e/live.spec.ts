import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeDb, createRepos, openDb, seedDb } from '../../packages/db/src/index';

// Live updates over /ws (F11). There is no chat composer yet (F13), so the test queues a run straight into the
// e2e database (playwright.config.ts: AGENTA_DB_PATH=data/e2e/agenta.db); the runner's scheduler poll picks it up.
const dbPath = resolve('data/e2e/agenta.db');

test.describe('live status', () => {
  test('the engine pill turns "limited" without a reload when a [mock:limit] run happens', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const db = openDb(dbPath);
    const repos = createRepos(db);
    // A previous run of this spec may have left the mock engine paused.
    repos.engineState.clearLimit('mock');
    const { bot, thread } = seedDb(repos);

    const frames: string[] = [];
    page.on('websocket', (ws) => {
      if (ws.url().endsWith('/ws')) ws.on('framereceived', (f) => frames.push(String(f.payload)));
    });
    await page.goto('/');
    const pill = page.getByTestId('mock-status');
    await expect(pill).toHaveText('Mock: on');
    await expect
      .poll(() => frames.some((f) => f.includes('"subscribed"') && f.includes('"global"')))
      .toBe(true);

    const run = repos.runs.create({
      botId: bot.id,
      threadId: thread.id,
      trigger: 'user',
      engine: 'mock',
      prompt: '[mock:limit]',
    });
    try {
      await expect(pill).toHaveText(/^Mock: limited until \d{2}:\d{2}$/, { timeout: 20_000 });
      await expect(pill).toHaveAttribute('data-tone', 'warn');
      expect(frames.some((f) => f.includes('"engine.state"') && f.includes('"mock"'))).toBe(true);
      await expect.poll(() => repos.runs.get(run.id)?.status).toBe('limited');
    } finally {
      // Cancel the automatic retry before lifting the pause, or it would run (and pause the engine) again.
      for (const retry of repos.runs.list({ status: 'queued' }))
        if (retry.retryOfRunId === run.id) await request.post(`/api/runs/${retry.id}/cancel`);
      repos.engineState.clearLimit('mock');
      closeDb(db);
    }
  });
});
