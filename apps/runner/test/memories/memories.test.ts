import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Memory } from '@agenta/db';
import type { MemoryView } from '@agenta/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import type { ContainerManager } from '../../src/containers/manager';
import { MemoryService, selectForRender } from '../../src/memories/service';
import { computerPreparer } from '../../src/runs/prepare';
import { buildServer } from '../../src/server';
import { type Harness, makeHarness, silent } from '../runs/helpers';

const FAKE_KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345';

describe('memory system (F22)', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const };
  let h: Harness;
  let memories: MemoryService;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let sharedDir: string;

  beforeEach(async () => {
    h = makeHarness();
    sharedDir = join(h.dir, 'shared');
    memories = new MemoryService({ repos: h.repos, bus: h.bus, log: silent, sharedDir });
    app = await buildServer(config, { repos: h.repos, memories });
  });
  afterEach(async () => {
    await app.close();
    h.close();
  });

  it('a saved memory appears in the rendered CLAUDE.md/AGENTS.md on the next run', async () => {
    const bot = { id: h.bot('Builder') };
    memories.create({ scope: 'bot', botId: bot.id, title: 'Package manager', contentMd: 'Always use pnpm.' });
    memories.create({ scope: 'shared', title: 'Team rule', contentMd: 'Small PRs only.' });
    const containers = {
      ensureRunning: async () => ({}),
      acquire: () => () => undefined,
    } as unknown as ContainerManager;
    const botsDir = join(h.dir, 'bots');
    const prepare = computerPreparer({ containers, botsDir, memories: (id) => memories.forRender(id) });
    (await prepare(h.repos.bots.get(bot.id)!, 'claude'))();
    for (const f of ['CLAUDE.md', 'AGENTS.md']) {
      const text = readFileSync(join(botsDir, bot.id, 'home', f), 'utf8');
      expect(text).toMatch(/## Memory[\s\S]*### Package manager\nAlways use pnpm\./);
      expect(text).toMatch(/## Team knowledge[\s\S]*### Team rule\nSmall PRs only\./);
    }
    // Other bots see the shared memory only.
    expect(memories.forRender(h.bot('Other')).map((m) => m.title)).toEqual(['Team rule']);
  });

  it('renders pinned first, then newest, within the word cap', () => {
    const mem = (title: string, n: number, updatedAt: string, pinned = false) =>
      ({ title, contentMd: Array(n).fill('w').join(' '), scope: 'bot', pinned, updatedAt }) as Memory;
    const picked = selectForRender(
      [
        mem('old', 10, '2026-01-01'),
        mem('new', 10, '2026-03-01'),
        mem('pinned', 10, '2025-01-01', true),
        mem('big', 100, '2026-02-01'),
      ],
      70,
    );
    // pinned (11 words) + new (11) fit; big (101) is cut to the 47 words left and nothing follows it.
    expect(picked.map((m) => m.title)).toEqual(['pinned', 'new', 'big']);
    const total = picked.reduce((s, m) => s + `${m.title} ${m.contentMd}`.split(/\s+/).length, 0);
    expect(total).toBeLessThanOrEqual(70 + 2); // + the "… (truncated)" marker
    // The default cap is ~2,000 words (+ the truncation marker).
    const huge = selectForRender([mem('a', 3000, '2026-01-01'), mem('b', 5, '2025-01-01')]);
    expect(huge.map((m) => m.title)).toEqual(['a']);
    expect(huge[0]!.contentMd.split(' ').length).toBeLessThanOrEqual(2_000 + 2);
  });

  it('rejects secrets on save and edit, through the API and the save_memory path', async () => {
    const bot = { id: h.bot('Builder') };
    const res = await app.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { scope: 'bot', botId: bot.id, title: 'Keys', contentMd: `the key is ${FAKE_KEY}` },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('secret_detected');
    expect(res.body).not.toContain(FAKE_KEY);
    expect(h.repos.memories.list()).toEqual([]);

    const m = memories.create({ scope: 'shared', title: 'Ok', contentMd: 'fine' });
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/memories/${m.id}`,
      payload: { contentMd: `token: ${FAKE_KEY}` },
    });
    expect(patch.statusCode).toBe(422);
    expect(h.repos.memories.get(m.id)?.contentMd).toBe('fine');
  });

  it('CRUD, pin and full-text search over the API, with live events', async () => {
    const bot = { id: h.bot('Builder') };
    const created = await app.inject({
      method: 'POST',
      url: '/api/memories',
      payload: {
        scope: 'bot',
        botId: bot.id,
        title: 'Deploying',
        contentMd: 'Staging first.',
        tags: ['ops'],
      },
    });
    expect(created.statusCode).toBe(201);
    const m = created.json() as MemoryView;
    expect(m).toMatchObject({ scope: 'bot', botId: bot.id, pinned: false, tags: ['ops'] });
    expect(h.published.some((p) => p.event.type === 'memory.changed')).toBe(true);

    const pinned = await app.inject({
      method: 'PATCH',
      url: `/api/memories/${m.id}`,
      payload: { pinned: true },
    });
    expect(pinned.json().pinned).toBe(true);

    const list = (q: string) =>
      app.inject({ method: 'GET', url: `/api/memories?${q}` }).then((r) => r.json());
    expect((await list(`botId=${bot.id}`)).map((x: MemoryView) => x.id)).toEqual([m.id]);
    expect((await list('q=deploys')).map((x: MemoryView) => x.id)).toEqual([m.id]);
    expect(await list('scope=shared')).toEqual([]);

    expect((await app.inject({ method: 'DELETE', url: `/api/memories/${m.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/memories/${m.id}` })).statusCode).toBe(404);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { scope: 'bot', title: 'x', contentMd: 'y' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('mirrors shared memories to /shared/knowledge and leaves other files alone', () => {
    const dir = join(sharedDir, 'knowledge');
    const m = memories.create({
      scope: 'shared',
      title: 'Repo Layout',
      contentMd: 'apps/ and packages/',
      tags: ['repo'],
    });
    expect(readdirSync(dir)).toEqual([`${m.id}-repo-layout.md`]);
    expect(readFileSync(join(dir, `${m.id}-repo-layout.md`), 'utf8')).toBe(
      '# Repo Layout\n\n_Tags: repo_\n\napps/ and packages/\n',
    );
    memories.update(m.id, { title: 'Monorepo layout' });
    expect(readdirSync(dir)).toEqual([`${m.id}-monorepo-layout.md`]);
    memories.delete(m.id);
    expect(readdirSync(dir)).toEqual([]);
    // Bot memories are never mirrored.
    memories.create({ scope: 'bot', botId: h.bot('B'), title: 'Mine', contentMd: 'x' });
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(join(sharedDir, 'knowledge'))).toBe(true);
  });
});
