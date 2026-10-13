import type { BotView } from '@agenta/shared';
import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';

// Files & shared workspace (F15). Browsing, editing and uploading need no container: the runner reads the bot's
// home on disk. The final check reads the saved file back from a real shell in the bot's computer.

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function createBot(request: APIRequestContext): Promise<BotView> {
  const res = await request.post('/api/bots', { data: { name: `Files Bot ${uid()}`, engine: 'mock' } });
  expect(res.status()).toBe(201);
  return (await res.json()) as BotView;
}

async function openFiles(page: Page, bot: BotView): Promise<Locator> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/bots');
  await page.getByRole('article', { name: bot.name }).getByRole('button', { name: 'Computer' }).click();
  const panel = page.getByRole('complementary', { name: 'Computer' });
  await panel.getByRole('tab', { name: 'Files' }).click();
  return panel;
}

const item = (scope: Locator, name: string) => scope.getByRole('treeitem', { name, exact: true });

// 1×1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('files', () => {
  test('browse home and the team share, folders, rename, delete, noise toggle, previews', async ({
    page,
    request,
  }) => {
    const bot = await createBot(request);
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(e.message));
    const panel = await openFiles(page, bot);
    const tree = panel.getByRole('tree');

    // Home: the bot's standard layout, `work` unfolded.
    await expect(item(tree, 'work')).toHaveAttribute('aria-expanded', 'true');
    await expect(item(tree, 'notes')).toBeVisible();
    await expect(item(tree, 'CLAUDE.md')).toBeVisible();
    await expect(panel.getByTestId('files-cwd')).toHaveText('/home/bot/work');

    // Noise folders stay hidden until toggled.
    expect(
      (
        await request.post(`/api/bots/${bot.id}/files/mkdir`, {
          data: { root: 'home', path: 'work/node_modules' },
        })
      ).status(),
    ).toBe(201);
    await panel.getByRole('button', { name: 'Refresh' }).click();
    await expect(item(tree, 'node_modules')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Show noise folders' }).click();
    await expect(item(tree, 'node_modules')).toBeVisible();
    await panel.getByRole('button', { name: 'Hide noise folders' }).click();
    await expect(item(tree, 'node_modules')).toHaveCount(0);

    // New folder inside work, then upload an image and a text file into it via the file picker.
    await panel.getByRole('button', { name: 'New folder' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/Name/).fill('reports');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(item(tree, 'reports')).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.getByTestId('files-cwd')).toHaveText('/home/bot/work/reports');
    await panel.getByTestId('files-upload-input').setInputFiles([
      { name: 'dot.png', mimeType: 'image/png', buffer: PNG },
      { name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('first draft\n') },
    ]);
    const reports = item(tree, 'reports');
    await expect(item(reports, 'dot.png')).toBeVisible();
    await expect(item(reports, 'draft.txt')).toBeVisible();

    // Same name again → asks before replacing.
    await panel.getByTestId('files-upload-input').setInputFiles({
      name: 'draft.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('second draft\n'),
    });
    await expect(dialog).toContainText('Replace draft.txt?');
    await dialog.getByRole('button', { name: 'Replace' }).click();

    // Image preview renders the bytes.
    await item(reports, 'dot.png').getByRole('button', { name: 'dot.png' }).click();
    const img = panel.getByRole('img', { name: 'dot.png' });
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
    await expect(panel.getByTestId('computer-file-path')).toHaveText('/home/bot/work/reports/dot.png');
    const download = page.waitForEvent('download');
    await panel.getByRole('link', { name: 'Download' }).click();
    expect((await download).suggestedFilename()).toBe('dot.png');
    await panel.getByRole('button', { name: 'Back to files' }).click();

    // Text opens read-only in the editor with the replaced content.
    await item(reports, 'draft.txt').getByRole('button', { name: 'draft.txt' }).click();
    await expect(panel.getByTestId('code-editor')).toHaveAttribute('data-readonly', 'true');
    await expect(panel.locator('.view-lines')).toContainText('second draft');
    await panel.getByRole('button', { name: 'Back to files' }).click();

    // Rename, then delete (with confirmation).
    await item(reports, 'draft.txt').hover();
    await panel.getByRole('button', { name: 'Rename draft.txt' }).click();
    await dialog.getByLabel('New name').fill('final.txt');
    await dialog.getByRole('button', { name: 'Rename' }).click();
    await expect(item(reports, 'final.txt')).toBeVisible();
    await expect(item(reports, 'draft.txt')).toHaveCount(0);
    await item(reports, 'final.txt').hover();
    await panel.getByRole('button', { name: 'Delete final.txt' }).click();
    await expect(dialog).toContainText('Delete final.txt?');
    await dialog.getByRole('button', { name: 'Delete' }).click();
    await expect(item(reports, 'final.txt')).toHaveCount(0);

    // Team share: the standard folders, and a file dropped onto a folder lands in it.
    await panel.getByRole('radio', { name: 'Shared' }).click();
    for (const name of ['knowledge', 'decisions', 'handoff', 'projects'])
      await expect(item(tree, name)).toBeVisible();
    await expect(panel.getByTestId('files-cwd')).toHaveText('/shared');
    // A leftover from an aborted earlier run would (rightly) trigger the Replace prompt.
    await request.delete(`/api/bots/${bot.id}/files?root=shared&path=knowledge/team-notes.md`);
    const knowledge = item(tree, 'knowledge');
    const drop = await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      dt.items.add(
        new File(['# Team notes\n\nShared **knowledge**.\n'], 'team-notes.md', { type: 'text/markdown' }),
      );
      return dt;
    });
    const row = knowledge.locator('> div');
    await row.dispatchEvent('dragover', { dataTransfer: drop });
    await row.dispatchEvent('drop', { dataTransfer: drop });
    // Dropping unfolds the target folder.
    await expect(knowledge).toHaveAttribute('aria-expanded', 'true');
    await item(knowledge, 'team-notes.md').getByRole('button', { name: 'team-notes.md' }).click();
    await expect(
      panel.getByTestId('markdown-preview').getByRole('heading', { name: 'Team notes' }),
    ).toBeVisible();
    await expect(panel.getByTestId('computer-file-path')).toHaveText('/shared/knowledge/team-notes.md');
    await panel.getByRole('button', { name: 'Source' }).click();
    await expect(panel.locator('.view-lines')).toContainText('Shared **knowledge**.');

    // Clean up the shared file so reruns start from the same state.
    await request.delete(`/api/bots/${bot.id}/files?root=shared&path=knowledge/team-notes.md`);
    expect(problems).toEqual([]);
  });

  test('upload → view → edit → save → see the change from the terminal', async ({ page, request }) => {
    test.setTimeout(240_000);
    const bot = await createBot(request);
    const panel = await openFiles(page, bot);
    const tree = panel.getByRole('tree');

    await panel.getByTestId('files-upload-input').setInputFiles({
      name: 'plan.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Plan\n\nStep one.\n'),
    });
    const work = item(tree, 'work');
    await item(work, 'plan.md').getByRole('button', { name: 'plan.md' }).click();
    await expect(panel.getByTestId('markdown-preview')).toContainText('Step one.');

    await panel.getByRole('button', { name: 'Edit' }).click();
    const editor = panel.getByTestId('code-editor');
    await expect(editor).toHaveAttribute('data-readonly', 'false');
    await panel.locator('.view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('Step two from the editor.');
    await expect(panel.getByRole('button', { name: 'Save' })).toBeEnabled();
    await page.keyboard.press('Control+s');
    await expect(page.getByText('Saved plan.md')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Save' })).toBeDisabled();

    // A stale save is refused: the bot changes the file on disk, then the owner saves again.
    await request.put(`/api/bots/${bot.id}/files/content`, {
      data: { root: 'home', path: 'work/plan.md', content: '# Plan\n\nRewritten by the bot.\n' },
    });
    await page.keyboard.type(' Extra.');
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(panel.getByRole('alert')).toContainText('changed on disk');
    await panel.getByRole('button', { name: 'Reload' }).click();
    await expect(panel.locator('.view-lines')).toContainText('Rewritten by the bot.');

    // Edit again from the reloaded version and save.
    await panel.getByRole('button', { name: 'Edit' }).click();
    await panel.locator('.view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('Saved for the terminal.');
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved plan.md').last()).toBeVisible();

    // The bot's own shell sees the saved file.
    await panel.getByRole('tab', { name: 'Terminal' }).click();
    await panel.getByRole('button', { name: 'Open terminal' }).click();
    await expect(panel.locator('[data-testid="terminal-status"]:visible')).toHaveAttribute(
      'data-state',
      'open',
      {
        timeout: 150_000,
      },
    );
    const screen = panel.locator('[data-testid="terminal"]:visible .xterm-rows');
    await expect(screen).toContainText('$', { timeout: 15_000 });
    await panel.locator('[data-testid="terminal"]:visible').click();
    await page.keyboard.type('cat ~/work/plan.md; echo "made in shell" > ~/work/from-shell.txt');
    await page.keyboard.press('Enter');
    await expect(screen).toContainText('Rewritten by the bot.Saved for the terminal.');

    // And a file the shell made shows up in the tree without a manual refresh (no engine event: polling).
    await panel.getByRole('tab', { name: 'Files' }).click();
    await panel.getByRole('button', { name: 'Back to files' }).click();
    await expect(item(work, 'from-shell.txt')).toBeVisible({ timeout: 15_000 });

    await request.post(`/api/bots/${bot.id}/computer/stop`);
  });
});
