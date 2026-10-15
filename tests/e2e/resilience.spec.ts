import { type APIRequestContext, expect, type Page, test, type WebSocketRoute } from '@playwright/test';
import type { BotView } from '../../packages/shared/src/index';

// Resilience and the request guard (F33), against the mock engine. Runner restarts mid-run, Docker going away and
// usage limits are covered by the runner unit tests (runs/lifecycle, containers/manager).

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function createBot(request: APIRequestContext): Promise<BotView> {
  const res = await request.post('/api/bots', { data: { name: `Steady ${uid()}`, engine: 'mock' } });
  expect(res.status()).toBe(201);
  return (await res.json()) as BotView;
}

/** Routes the live socket through the test, so it can be cut and kept down. */
async function controlLiveSocket(page: Page) {
  const open: WebSocketRoute[] = [];
  let down = false;
  let connects = 0;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    connects++;
    if (down) return void ws.close();
    ws.connectToServer();
    open.push(ws);
  });
  return {
    connects: () => connects,
    cut() {
      down = true;
      for (const ws of open.splice(0)) void ws.close();
    },
    restore() {
      down = false;
    },
  };
}

test.describe('resilience', () => {
  test('a reply sent while the live socket is down shows up once it reconnects, without a reload', async ({
    page,
    request,
  }) => {
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(e.message));
    const bot = await createBot(request);
    const live = await controlLiveSocket(page);
    await page.goto(`/threads/${bot.dmThreadId}`);
    await expect.poll(live.connects).toBeGreaterThan(0);
    await expect(page.getByText(`Start a conversation with ${bot.name}`)).toBeVisible();

    live.cut();
    // The bot answers while the page is offline (sent from elsewhere, e.g. another tab).
    const res = await request.post(`/api/threads/${bot.dmThreadId}/messages`, {
      data: { content: '[mock:hello] are you there?' },
    });
    expect(res.status()).toBe(201);
    const final = `Hello! I'm ${bot.name}, running on the mock engine. How can I help?`;
    await expect
      .poll(async () => {
        const runs = (await (await request.get(`/api/runs?threadId=${bot.dmThreadId}`)).json()) as {
          status: string;
        }[];
        return runs.map((r) => r.status);
      })
      .toEqual(['succeeded']);
    await expect(page.getByText(final)).toHaveCount(0);

    // Reconnect (backoff retries until the socket is allowed again), then everything refetches.
    const before = live.connects();
    live.restore();
    await expect.poll(live.connects, { timeout: 20_000 }).toBeGreaterThan(before);
    await expect(page.getByText(final)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('message-user').getByText('[mock:hello] are you there?')).toBeVisible();
    expect(problems).toEqual([]);
  });

  test('the API refuses cross-site writes and foreign hosts through the web server', async ({ request }) => {
    // A page on another site posting to the API (CSRF): refused before any route runs.
    const csrf = await request.post('/api/onboarding/team', {
      headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(csrf.status()).toBe(403);
    expect(await csrf.json()).toMatchObject({ error: { code: 'forbidden_request' } });

    // DNS rebinding: a foreign name pointing at 127.0.0.1 is refused even for reads.
    const rebind = await request.get('/api/bots', { headers: { host: 'rebind.evil.example:3000' } });
    expect(rebind.status()).toBe(403);

    // The app's own origin still works.
    const own = await request.get('/api/bots', { headers: { origin: 'http://127.0.0.1:3000' } });
    expect(own.status()).toBe(200);
  });
});
