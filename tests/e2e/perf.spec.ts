import { expect, test } from '@playwright/test';
import { closeDb, createRepos, openDb } from '@agenta/db';
import type { BotView } from '../../packages/shared/src/index';

// Performance (F33): a thread with 2,000 messages opens fast, loads its history page by page while scrolling up,
// and scrolls smoothly once all of it is on the page (rows use content-visibility, not a virtual list).

const COUNT = 2000;
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function seedThread(bot: BotView): void {
  const db = openDb('data/e2e/agenta.db');
  try {
    const repos = createRepos(db);
    db.transaction(() => {
      for (let i = 1; i <= COUNT; i++) {
        const n = String(i).padStart(4, '0');
        repos.messages.create(
          i % 2
            ? { threadId: bot.dmThreadId!, authorType: 'user', contentMd: `Question ${n}: how is it going?` }
            : {
                threadId: bot.dmThreadId!,
                authorType: 'bot',
                authorBotId: bot.id,
                contentMd: `Answer ${n}: going well.\n\n- **step** one\n- \`code\` two\n\n\`\`\`ts\nconst n = ${i};\n\`\`\``,
              },
        );
      }
    });
  } finally {
    closeDb(db);
  }
}

test('a 2,000-message thread opens fast, pages in its history and scrolls smoothly', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const res = await request.post('/api/bots', { data: { name: `Chatty ${uid()}`, engine: 'mock' } });
  const bot = (await res.json()) as BotView;
  seedThread(bot);

  const t0 = Date.now();
  await page.goto(`/threads/${bot.dmThreadId}`);
  await expect(page.getByText('Answer 2000: going well.')).toBeVisible();
  const openMs = Date.now() - t0;

  // Scroll to the top until the first message is loaded (50 per page).
  const list = page.getByTestId('message-list');
  const t1 = Date.now();
  await expect
    .poll(
      async () => {
        await list.evaluate((el) => (el.scrollTop = 0));
        return page.getByText('Question 0001: how is it going?').count();
      },
      { timeout: 120_000, intervals: [100] },
    )
    .toBe(1);
  const historyMs = Date.now() - t1;
  await expect(list.locator(':scope > div > div')).toHaveCount(COUNT + 1); // + the "load older" row

  // Scroll top → bottom over ~2 s and record the gaps between frames.
  const frames = await list.evaluate(async (el) => {
    const gaps: number[] = [];
    const steps = 120;
    let last = performance.now();
    for (let i = 0; i <= steps; i++) {
      el.scrollTop = ((el.scrollHeight - el.clientHeight) * i) / steps;
      await new Promise(requestAnimationFrame);
      const now = performance.now();
      gaps.push(now - last);
      last = now;
    }
    return gaps.sort((a, b) => a - b);
  });
  const p95 = frames[Math.floor(frames.length * 0.95)]!;
  const max = frames.at(-1)!;
  test.info().annotations.push({
    type: 'perf',
    description: `open ${openMs} ms, full history ${historyMs} ms, scroll frame p95 ${p95.toFixed(1)} ms, max ${max.toFixed(1)} ms`,
  });
  console.log(test.info().annotations.at(-1)!.description);
  expect(openMs).toBeLessThan(10_000); // includes the dev server compiling the route on a cold start
  // Smooth: most frames well under 50 ms (20 fps) even on a loaded CI box; no frame freezes for half a second.
  expect(p95).toBeLessThan(50);
  expect(max).toBeLessThan(500);

  await request.delete(`/api/bots/${bot.id}`, { data: { confirmName: bot.name, deleteHome: true } });
});
