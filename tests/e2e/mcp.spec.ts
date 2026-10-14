import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import type { ApprovalView, BotView, McpServerView } from '../../packages/shared/src/index';

// MCP gateway (F35) against the mock engine and the stdio echo fixture (one read tool, one write tool).
// [mock:mcp] gw:<slug>__<tool> calls gateway tools through the Platform MCP tools, like a real engine would.

const FIXTURE = join(process.cwd(), 'tests/fixtures/mcp-echo/server.mjs');
const E2E_SECRET = 'e2e-echo-secret-0123456789'; // playwright.config.ts → E2E_ECHO_KEY
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function trackConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

async function createBot(request: APIRequestContext, name: string): Promise<BotView> {
  const res = await request.post('/api/bots', { data: { name: `${name} ${uid()}`, engine: 'mock' } });
  expect(res.status()).toBe(201);
  return (await res.json()) as BotView;
}

async function createEcho(request: APIRequestContext, slug: string): Promise<McpServerView> {
  const res = await request.post('/api/mcp-servers', {
    data: {
      server: {
        name: `Echo ${slug}`,
        slug,
        transport: 'stdio',
        command: 'node',
        args: [FIXTURE],
        envRefs: { ECHO_API_KEY: 'E2E_ECHO_KEY' },
      },
    },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as McpServerView;
}

async function send(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: /^Message / });
  await box.fill(text);
  await box.press('Control+Enter');
}

test.describe('MCP gateway', () => {
  let problems: string[];
  test.beforeEach(({ page }) => {
    problems = trackConsole(page);
  });
  test.afterEach(() => {
    expect(problems, 'console errors/warnings').toEqual([]);
  });

  test('add a server with the form → Test connection lists both tools with their policies', async ({
    page,
  }) => {
    const name = `Echo form ${uid()}`;
    await page.goto('/settings');
    await page.getByRole('link', { name: 'Manage MCP servers' }).click();
    await expect(page).toHaveURL(/\/settings\/mcp$/);
    await page.getByRole('button', { name: 'Add server' }).click();
    const form = page.getByRole('form', { name: 'Add MCP server' });
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByLabel('What it is for').fill('Echo things back (test fixture).');
    await form.getByLabel('Command').fill('node');
    await form.getByLabel('Arguments (one per line)').fill(FIXTURE);
    await form.getByLabel('Environment (VAR=ENV_LOCAL_NAME per line)').fill('ECHO_API_KEY=E2E_ECHO_KEY');
    await form.getByRole('button', { name: 'Add server' }).click();

    const card = page.getByRole('article', { name: `MCP server ${name}` });
    await expect(card).toContainText('Echo things back (test fixture).');
    await card.getByRole('button', { name: 'Test connection' }).click();
    await expect(card.getByTestId('mcp-state')).toHaveText('connected');
    await expect(card.getByLabel('Policy for echo')).toHaveValue('allow');
    await expect(card.getByLabel('Policy for save_note')).toHaveValue('approval');
    await expect(card.getByTestId('tool-echo')).toContainText('Echoes the text back.');

    // The owner can tighten a tool.
    await card.getByLabel('Policy for echo').selectOption('approval');
    await expect(card.getByLabel('Policy for echo')).toHaveValue('approval');
  });

  test('paste mcpServers JSON → literal secrets become .env.local variables → add → test', async ({
    page,
    request,
  }) => {
    const key = `echo-json-${uid()}`;
    const literal = 'literal-never-stored-987654321';
    await page.goto('/settings/mcp');
    await page.getByRole('button', { name: 'Paste JSON' }).click();
    await page.getByLabel(/Paste an mcpServers config/).fill(
      JSON.stringify({
        mcpServers: { [key]: { command: 'node', args: [FIXTURE], env: { E2E_ECHO_KEY: literal } } },
      }),
    );
    await page.getByRole('button', { name: 'Preview' }).click();
    const preview = page.getByLabel('Preview');
    await expect(preview).toContainText(`${key} (${key}, stdio: node ${FIXTURE})`);
    await expect(preview.getByLabel('Secrets to move')).toContainText('E2E_ECHO_KEY=…');
    await expect(preview).not.toContainText(literal);
    await preview.getByRole('button', { name: 'Add 1 server' }).click();

    const card = page.getByRole('article', { name: `MCP server ${key}` });
    await card.getByRole('button', { name: 'Test connection' }).click();
    await expect(card.getByTestId('mcp-state')).toHaveText('connected');
    await expect(card.getByTestId(/^tool-/)).toHaveCount(2);

    const all = await (await request.get('/api/mcp-servers')).text();
    expect(all).not.toContain(literal);
    expect(all).not.toContain(E2E_SECRET);
  });

  test('a preset fills the form; its network command is shown and recorded for the owner', async ({
    page,
  }) => {
    await page.goto('/settings/mcp');
    await page.getByRole('button', { name: 'Presets' }).click();
    await expect(page.getByRole('list', { name: 'Presets' }).getByRole('listitem')).toHaveCount(12);
    await page.getByRole('button', { name: 'Use preset Linear' }).click();
    const form = page.getByRole('form', { name: 'Add MCP server' });
    await expect(form.getByLabel('URL')).toHaveValue('https://mcp.linear.app/mcp');
    await expect(form.getByLabel('Headers (Name: value per line)')).toHaveValue(
      'Authorization: Bearer ${LINEAR_API_KEY}',
    );
    const slug = `linear-${uid()}`;
    await form.getByLabel('Slug').fill(slug);
    await form.getByRole('button', { name: 'Add server' }).click();
    const card = page.getByTestId(`mcp-server-${slug}`);
    await expect(card).toContainText('Set LINEAR_API_KEY=… in .env.local');
    await expect(card.getByLabel('Network command for Linear')).toHaveText(
      'sbx policy allow network --sandbox agent-a mcp.linear.app',
    );
    expect(readFileSync('data/e2e/HUMAN_TODO.md', 'utf8')).toContain(
      'sbx policy allow network --sandbox agent-a mcp.linear.app',
    );
  });

  test('granted bot calls the read tool and, after approval, the write tool; a bot without access is refused', async ({
    page,
    request,
  }) => {
    const slug = `echo-${uid()}`;
    const server = await createEcho(request, slug);
    expect((await (await request.post(`/api/mcp-servers/${server.id}/test`)).json()).tools).toHaveLength(2);
    const bot = await createBot(request, 'Researcher');
    const other = await createBot(request, 'Outsider');

    // Grant on the bot's page.
    await page.goto(`/bots/${bot.id}`);
    const grant = page.getByTestId(`bot-mcp-${slug}`);
    await grant.getByRole('checkbox', { name: new RegExp(`Echo ${slug}`) }).click();
    await expect(grant.getByRole('checkbox', { name: new RegExp(`Echo ${slug}`) })).toBeChecked();
    await expect(grant.getByRole('checkbox', { name: /Every tool/ })).toBeChecked();
    await expect
      .poll(
        async () =>
          ((await (await request.get(`/api/bots/${bot.id}/mcp-access`)).json()) as unknown[]).length,
      )
      .toBe(1);

    await page.goto(`/threads/${bot.dmThreadId}`);
    await send(page, `Look it up [mock:mcp] gw:${slug}__echo gw:${slug}__save_note`);
    await expect(page.getByText(`Called ${slug}__echo, ${slug}__save_note:`)).toBeVisible();
    const cards = page.getByTestId('tool-card');
    await expect(cards.filter({ hasText: `${slug}: Echo` })).toContainText('via the MCP gateway');
    await cards
      .filter({ hasText: `${slug}: Echo` })
      .locator('summary')
      .click();
    await expect(cards.filter({ hasText: `${slug}: Echo` }).getByTestId('tool-output')).toContainText(
      'echo: hello from the mock bot',
    );

    // The write tool waits for the owner.
    await page.goto('/');
    const card = page
      .getByRole('region', { name: /Waiting for your approval/ })
      .getByRole('listitem', { name: `${bot.name} asks to: Use ${slug}__save_note` });
    await expect(card).toContainText('hello from the mock bot');
    await card.getByRole('button', { name: 'Approve' }).click();
    await expect(card).toHaveCount(0);
    const all = (await (await request.get('/api/approvals')).json()) as ApprovalView[];
    const approval = all.find((a) => a.botId === bot.id && a.action === `Use ${slug}__save_note`)!;
    expect(approval.status).toBe('approved');

    await page.goto(`/threads/${bot.dmThreadId}`);
    await send(page, `Go ahead [mock:mcp] gw:${slug}__save_note ${approval.id}`);
    await expect(
      page.getByRole('listitem').filter({ hasText: 'saved note #1: hello from the mock bot' }),
    ).toBeVisible();

    // No access: refused, shown as a failed tool call.
    await page.goto(`/threads/${other.dmThreadId}`);
    await send(page, `Try [mock:mcp] gw:${slug}__echo`);
    await expect(
      page.getByRole('listitem').filter({ hasText: `You do not have access to the tool ${slug}__echo` }),
    ).toBeVisible();
    await expect(page.getByTestId('tool-card').filter({ hasText: `${slug}: Echo` })).toHaveCount(1);
  });

  test('web research: choosing the broad allowance shows the sbx command and records it', async ({
    page,
  }) => {
    await page.goto('/settings/mcp');
    const research = page.getByRole('article', { name: 'Web research' });
    await research.getByLabel(/Broad web allowance/).click();
    await expect(research.getByLabel(/Broad web allowance/)).toBeChecked();
    await expect(research.getByLabel('Web access command')).toHaveText(
      'sbx policy allow network --sandbox agent-a "**"',
    );
    expect(readFileSync('data/e2e/HUMAN_TODO.md', 'utf8')).toContain(
      'sbx policy allow network --sandbox agent-a "**"',
    );
    await research.getByLabel(/Allow domains one by one/).click();
    await expect(research.getByLabel(/Allow domains one by one/)).toBeChecked();
    await expect(research.getByLabel('Web access command')).toHaveText(
      'sbx policy allow network --sandbox agent-a <domain>',
    );
  });
});
