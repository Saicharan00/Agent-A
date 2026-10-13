import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DirListing, FileContent, FileMutationResponse } from '@agenta/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { contentDisposition } from '../../src/files/routes';
import { FilesService } from '../../src/files/service';
import { buildServer } from '../../src/server';
import { type Harness, makeHarness, silent } from '../runs/helpers';

describe('files API', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const };
  let h: Harness;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let botsDir: string;
  let sharedDir: string;
  let botId: string;
  let home: string;

  beforeEach(async () => {
    h = makeHarness();
    botsDir = join(h.dir, 'bots');
    sharedDir = join(h.dir, 'shared');
    const files = new FilesService({ repos: h.repos, bus: h.bus, log: silent as never, botsDir, sharedDir });
    app = await buildServer(config, { repos: h.repos, files });
    botId = h.bot('Helper');
    home = join(botsDir, botId, 'home');
  });
  afterEach(async () => {
    await app.close();
    h.close();
  });

  const url = (path: string, q: Record<string, string>) =>
    `/api/bots/${botId}/${path}?${new URLSearchParams(q).toString()}`;
  const list = (root: string, path = '') => app.inject({ url: url('files', { root, path }) });
  const upload = (q: Record<string, string>, body: Buffer | string) =>
    app.inject({
      method: 'POST',
      url: url('files/upload', q),
      headers: { 'content-type': 'application/octet-stream' },
      payload: body,
    });
  const filesEvents = () => h.published.filter((p) => p.event.type === 'files.changed');

  it('creates the team share layout and an untouched bot home on first access', async () => {
    for (const d of ['knowledge', 'decisions', 'handoff', 'projects']) {
      expect(existsSync(join(sharedDir, d))).toBe(true);
    }
    const res = await list('home');
    expect(res.statusCode).toBe(200);
    const names = res.json<DirListing>().entries.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['work', 'notes', 'CLAUDE.md', 'AGENTS.md']));
    const shared = (await list('shared')).json<DirListing>();
    expect(shared.entries.map((e) => e.name)).toEqual(['decisions', 'handoff', 'knowledge', 'projects']);
  });

  it('validates input and maps errors to typed codes', async () => {
    expect((await app.inject({ url: '/api/bots/bot_nope/files?root=home' })).json()).toEqual({
      error: { code: 'bot_not_found', message: 'Bot bot_nope not found' },
    });
    expect((await list('desktop')).statusCode).toBe(400);
    for (const path of ['../', '../../etc', '/etc', 'work/../..']) {
      const res = await list('home', path);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('outside_root');
    }
    const res = await list('home', 'missing');
    expect(res.statusCode).toBe(404);
  });

  it('upload → read → save → delete, publishing each change on the bot channel', async () => {
    let res = await upload({ root: 'home', path: 'work', name: 'notes.md' }, '# Hello\n');
    expect(res.statusCode).toBe(201);
    expect(res.json<FileMutationResponse>().entry).toMatchObject({
      path: 'work/notes.md',
      type: 'file',
      size: 8,
    });
    expect(readFileSync(join(home, 'work', 'notes.md'), 'utf8')).toBe('# Hello\n');

    res = await upload({ root: 'home', path: 'work', name: 'notes.md' }, 'again');
    expect(res.statusCode).toBe(409);
    res = await upload({ root: 'home', path: 'work', name: 'notes.md', overwrite: 'true' }, '# Hi\n');
    expect(res.statusCode).toBe(201);
    res = await upload({ root: 'home', path: 'work', name: '../evil' }, 'x');
    expect(res.statusCode).toBe(400);

    const content = (
      await app.inject({ url: url('files/content', { root: 'home', path: 'work/notes.md' }) })
    ).json<FileContent>();
    expect(content).toMatchObject({ content: '# Hi\n', binary: false, truncated: false });

    res = await app.inject({
      method: 'PUT',
      url: `/api/bots/${botId}/files/content`,
      payload: {
        root: 'home',
        path: 'work/notes.md',
        content: '# Edited\n',
        expectedModifiedAt: content.modifiedAt,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(readFileSync(join(home, 'work', 'notes.md'), 'utf8')).toBe('# Edited\n');
    res = await app.inject({
      method: 'PUT',
      url: `/api/bots/${botId}/files/content`,
      payload: {
        root: 'home',
        path: 'work/notes.md',
        content: 'x',
        expectedModifiedAt: '2000-01-01T00:00:00.000Z',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('modified_elsewhere');

    res = await app.inject({ method: 'DELETE', url: url('files', { root: 'home', path: 'work/notes.md' }) });
    expect(res.statusCode).toBe(204);
    expect(existsSync(join(home, 'work', 'notes.md'))).toBe(false);

    expect(filesEvents().map((p) => [p.channel, (p.event as { change: string }).change])).toEqual([
      [`bot:${botId}`, 'created'],
      [`bot:${botId}`, 'created'],
      [`bot:${botId}`, 'modified'],
      [`bot:${botId}`, 'deleted'],
    ]);
  });

  it('creates folders and renames in the team share, announced on global', async () => {
    let res = await app.inject({
      method: 'POST',
      url: `/api/bots/${botId}/files/mkdir`,
      payload: { root: 'shared', path: 'projects/alpha' },
    });
    expect(res.statusCode).toBe(201);
    res = await app.inject({
      method: 'POST',
      url: `/api/bots/${botId}/files/rename`,
      payload: { root: 'shared', from: 'projects/alpha', to: 'projects/beta' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<FileMutationResponse>().entry.path).toBe('projects/beta');
    expect(existsSync(join(sharedDir, 'projects', 'beta'))).toBe(true);
    res = await app.inject({
      method: 'POST',
      url: `/api/bots/${botId}/files/rename`,
      payload: { root: 'shared', from: 'projects/beta', to: '../escaped' },
    });
    expect(res.statusCode).toBe(403);
    expect(filesEvents().every((p) => p.channel === 'global')).toBe(true);
    expect(filesEvents()).toHaveLength(3);
  });

  it('serves raw bytes: images and PDFs inline, everything else as a download', async () => {
    await list('home');
    writeFileSync(join(home, 'work', 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(home, 'work', 'page.html'), '<script>alert(1)</script>');
    writeFileSync(join(home, 'work', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(home, 'work', 'résumé.pdf'), '%PDF-1.4');

    let res = await app.inject({ url: url('files/raw', { root: 'home', path: 'work/pic.png' }) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toMatch(/^inline/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect([...res.rawPayload]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    res = await app.inject({ url: url('files/raw', { root: 'home', path: 'work/page.html' }) });
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="page.html"/);

    res = await app.inject({ url: url('files/raw', { root: 'home', path: 'work/logo.svg' }) });
    expect(res.headers['content-security-policy']).toMatch(/sandbox/);

    res = await app.inject({
      url: url('files/raw', { root: 'home', path: 'work/résumé.pdf', download: '1' }),
    });
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`,
    );

    symlinkSync('/etc/hostname', join(home, 'work', 'host'));
    res = await app.inject({ url: url('files/raw', { root: 'home', path: 'work/host' }) });
    expect(res.statusCode).toBe(403);
  });

  it('refuses writes for archived bots but still lets the owner browse', async () => {
    h.repos.bots.archive(botId);
    expect((await list('home')).statusCode).toBe(200);
    const res = await upload({ root: 'home', path: '', name: 'x.txt' }, 'x');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('bot_archived');
  });

  it('quotes awkward names in Content-Disposition', () => {
    expect(contentDisposition('inline', 'a"b\\c.txt')).toBe(
      `inline; filename="a_b_c.txt"; filename*=UTF-8''a%22b%5Cc.txt`,
    );
  });
});

describe('engine file.changed events', () => {
  it('are re-published as files.changed for the bot (home) or the team (shared)', async () => {
    const h = makeHarness();
    const botId = h.bot('Echo');
    h.service.enqueue({ botId, threadId: h.dm(botId), trigger: 'user', prompt: '[mock:tools] go' });
    await h.service.idle();
    expect(h.published).toContainEqual({
      channel: `bot:${botId}`,
      event: { type: 'files.changed', botId, root: 'home', path: 'work/hello.txt', change: 'created' },
    });
    h.close();
  });
});
