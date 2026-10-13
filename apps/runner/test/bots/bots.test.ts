import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BotUpdateResponse, BotView } from '@agenta/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashMcpToken, verifyMcpToken } from '../../src/bots/mcp-token';
import { BotService } from '../../src/bots/service';
import { loadConfig } from '../../src/config';
import { ContainerManager } from '../../src/containers/manager';
import { MockEngine } from '../../src/engines/mock';
import { buildServer } from '../../src/server';
import { FakeDocker } from '../containers/fake-docker';
import { type Harness, makeHarness, silent } from '../runs/helpers';

describe('bots API', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const };
  let h: Harness;
  let docker: FakeDocker;
  let containers: ContainerManager;
  let bots: BotService;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let botsDir: string;

  beforeEach(async () => {
    h = makeHarness({ adapters: [new MockEngine({ slowMs: 60_000, tickMs: 1 })] });
    botsDir = join(h.dir, 'bots');
    docker = new FakeDocker();
    containers = new ContainerManager({
      docker,
      repos: h.repos,
      bus: h.bus,
      log: silent,
      botsDir,
      sharedDir: join(h.dir, 'shared'),
      healthPollMs: 1,
      healthTimeoutMs: 50,
    });
    bots = new BotService({ repos: h.repos, bus: h.bus, log: silent, botsDir, containers, runs: h.service });
    app = await buildServer(config, { repos: h.repos, runs: h.service, containers, bots });
  });
  afterEach(async () => {
    await app.close();
    h.close();
  });

  const create = async (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/bots', payload: body });
  const tokenFile = (id: string) => join(botsDir, id, 'home', '.agenta', 'mcp-token');

  it('creates a bot with a DM thread, a home and a hashed MCP token, but no container', async () => {
    const res = await create({ name: 'Code Reviewer', role: 'Reviews PRs', engine: 'claude' });
    expect(res.statusCode).toBe(201);
    const bot = res.json<BotView>();
    expect(bot).toMatchObject({
      name: 'Code Reviewer',
      slug: 'code-reviewer',
      engine: 'claude',
      model: null,
      status: 'stopped',
      archivedAt: null,
      lastActivityAt: null,
    });
    // Runtime secrets and container internals never leave the runner.
    expect(bot).not.toHaveProperty('mcpTokenHash');
    expect(bot).not.toHaveProperty('containerId');

    const dm = h.repos.threads.get(bot.dmThreadId!)!;
    expect(dm).toMatchObject({ kind: 'dm', title: 'Code Reviewer' });
    expect(h.repos.threads.listMembers(dm.id).map((b) => b.id)).toEqual([bot.id]);

    expect(existsSync(join(botsDir, bot.id, 'home', 'CLAUDE.md'))).toBe(true);
    const token = readFileSync(tokenFile(bot.id), 'utf8').trim();
    expect(statSync(tokenFile(bot.id)).mode & 0o777).toBe(0o600);
    const row = h.repos.bots.get(bot.id)!;
    expect(row.mcpTokenHash).toBe(hashMcpToken(token));
    expect(row.mcpTokenHash).not.toContain(token);
    expect(verifyMcpToken(token, row.mcpTokenHash)).toBe(true);
    expect(verifyMcpToken(`${token}x`, row.mcpTokenHash)).toBe(false);

    expect(docker.containers.size).toBe(0); // created lazily on first use
    expect(h.published).toContainEqual({
      channel: 'global',
      event: { type: 'bots.changed', botId: bot.id, change: 'created' },
    });
  });

  it('validates input and keeps slugs unique', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ name: '', engine: 'claude' }, /^name:/],
      [{ name: 'X', engine: 'gpt' }, /^engine:/],
      [{ name: 'X', engine: 'claude', slug: 'Bad Slug' }, /^slug:/],
      [{ name: 'X', engine: 'claude', avatarColor: 'red' }, /^avatarColor:/],
      [{ name: 'X', engine: 'claude', settings: { memoryMb: 10 } }, /^settings\.memoryMb:/],
      [{ name: 'X', engine: 'claude', isLead: true }, /isLead/],
    ];
    for (const [body, msg] of cases) {
      const res = await create(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe('invalid_body');
      expect(res.json().error.message).toMatch(msg);
    }

    const a = (await create({ name: 'Writer', engine: 'codex' })).json<BotView>();
    const b = (await create({ name: 'Writer', engine: 'codex' })).json<BotView>();
    expect([a.slug, b.slug]).toEqual(['writer', 'writer-2']);

    const taken = await create({ name: 'Other', engine: 'codex', slug: 'writer' });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.code).toBe('slug_taken');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/bots/${b.id}`,
      payload: { slug: 'writer' },
    });
    expect(patch.statusCode).toBe(409);
    const same = await app.inject({ method: 'PATCH', url: `/api/bots/${a.id}`, payload: { slug: 'writer' } });
    expect(same.statusCode).toBe(200);
  });

  it('gets, lists and updates bots; renaming renames the DM thread', async () => {
    const bot = (await create({ name: 'Researcher', engine: 'claude' })).json<BotView>();
    expect((await app.inject({ url: `/api/bots/${bot.id}` })).json<BotView>().id).toBe(bot.id);
    const missing = await app.inject({ url: '/api/bots/bot_nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('bot_not_found');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/bots/${bot.id}`,
      payload: {
        name: 'Deep Researcher',
        instructions: '# Rules\nCite sources.',
        model: 'opus',
        avatarShape: 'hexagon',
        notifications: 'mentions',
        sidebarVisible: false,
        settings: { cpus: 1, memoryMb: 1024, idleTimeoutMin: 5, runTimeoutMin: 20, flags: {} },
      },
    });
    expect(res.statusCode).toBe(200);
    const { bot: updated, restartRequired } = res.json<BotUpdateResponse>();
    expect(restartRequired).toBe(false);
    expect(updated).toMatchObject({
      name: 'Deep Researcher',
      slug: 'researcher', // the handle doesn't follow renames
      instructions: '# Rules\nCite sources.',
      model: 'opus',
      sidebarVisible: false,
      settings: { cpus: 1, memoryMb: 1024, idleTimeoutMin: 5, runTimeoutMin: 20 },
    });
    expect(h.repos.threads.get(bot.dmThreadId!)!.title).toBe('Deep Researcher');

    const bad = await app.inject({ method: 'PATCH', url: `/api/bots/${bot.id}`, payload: { engine: 'x' } });
    expect(bad.statusCode).toBe(400);

    h.service.enqueue({ botId: bot.id, threadId: bot.dmThreadId, trigger: 'user', prompt: 'hi' });
    await h.service.idle();
    const list = (await app.inject({ url: '/api/bots' })).json<BotView[]>();
    expect(list.find((b) => b.id === bot.id)!.lastActivityAt).toMatch(/^\d{4}-/);
  });

  it('a limits change recreates a stopped container and flags a running one for restart', async () => {
    const bot = (await create({ name: 'Builder', engine: 'claude' })).json<BotView>();
    const limits = (memoryMb: number) => ({
      settings: { ...bot.settings, memoryMb },
    });

    await containers.start(bot.id);
    let res = (
      await app.inject({ method: 'PATCH', url: `/api/bots/${bot.id}`, payload: limits(4096) })
    ).json<BotUpdateResponse>();
    expect(res.restartRequired).toBe(true);
    expect(docker.containers.size).toBe(1);

    await containers.stop(bot.id);
    res = (
      await app.inject({ method: 'PATCH', url: `/api/bots/${bot.id}`, payload: limits(3072) })
    ).json<BotUpdateResponse>();
    expect(res.restartRequired).toBe(false);
    expect(docker.containers.size).toBe(0);
    const started = await containers.start(bot.id);
    const spec = docker.containers.get(started.containerId!)!.spec;
    expect(spec.memoryBytes).toBe(3072 * 1024 * 1024);

    // Instruction edits don't touch the container.
    res = (
      await app.inject({ method: 'PATCH', url: `/api/bots/${bot.id}`, payload: { instructions: 'x' } })
    ).json<BotUpdateResponse>();
    expect(res.restartRequired).toBe(false);
    expect(docker.containers.has(started.containerId!)).toBe(true);
  });

  it('archive cancels runs, stops the computer and hides the bot; restore brings it back', async () => {
    const bot = (await create({ name: 'Slowpoke', engine: 'mock' })).json<BotView>();
    await containers.start(bot.id);
    const run = h.service.enqueue({
      botId: bot.id,
      threadId: bot.dmThreadId,
      trigger: 'user',
      prompt: '[mock:slow]',
    });
    await new Promise((r) => setTimeout(r, 20));

    const res = await app.inject({ method: 'POST', url: `/api/bots/${bot.id}/archive` });
    expect(res.statusCode).toBe(200);
    expect(res.json<BotView>()).toMatchObject({ status: 'stopped', archivedAt: expect.any(String) });
    expect(h.repos.runs.get(run.id)!.status).toBe('cancelled');
    expect(() => h.service.enqueue({ botId: bot.id, trigger: 'user', prompt: 'x' })).toThrow(/archived/);

    const ids = (url: string) => app.inject({ url }).then((r) => r.json<BotView[]>().map((b) => b.id));
    expect(await ids('/api/bots')).not.toContain(bot.id);
    expect(await ids('/api/bots?archived=only')).toEqual([bot.id]);
    expect(await ids('/api/bots?archived=include')).toContain(bot.id);
    expect((await app.inject({ url: '/api/bots?archived=maybe' })).statusCode).toBe(400);

    const restored = await app.inject({ method: 'POST', url: `/api/bots/${bot.id}/restore` });
    expect(restored.json<BotView>()).toMatchObject({ archivedAt: null, dmThreadId: bot.dmThreadId });
    expect(await ids('/api/bots')).toContain(bot.id);
  });

  it('delete requires the exact name, removes the container and DM thread, and keeps the home unless asked', async () => {
    const keep = (await create({ name: 'Keeper', engine: 'claude' })).json<BotView>();
    const wipe = (await create({ name: 'Wiper', engine: 'claude' })).json<BotView>();
    await containers.start(keep.id);
    h.repos.messages.create({ threadId: keep.dmThreadId!, authorType: 'user', contentMd: 'hello' });

    const del = (id: string, payload: unknown) =>
      app.inject({ method: 'DELETE', url: `/api/bots/${id}`, payload: payload as object });
    const wrong = await del(keep.id, { confirmName: 'keeper' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('confirm_mismatch');
    expect((await del(keep.id, {})).statusCode).toBe(400);
    expect(h.repos.bots.get(keep.id)!.archivedAt).toBeNull();

    expect((await del(keep.id, { confirmName: 'Keeper' })).statusCode).toBe(204);
    expect(h.repos.bots.get(keep.id)).toBeUndefined();
    expect(h.repos.threads.get(keep.dmThreadId!)).toBeUndefined();
    expect(docker.containers.size).toBe(0);
    expect(existsSync(join(botsDir, keep.id, 'home'))).toBe(true);
    expect((await app.inject({ url: `/api/bots/${keep.id}` })).statusCode).toBe(404);

    expect((await del(wipe.id, { confirmName: 'Wiper', deleteHome: true })).statusCode).toBe(204);
    expect(existsSync(join(botsDir, wipe.id))).toBe(false);
    expect(h.published.filter((p) => p.channel === 'global').map((p) => p.event)).toContainEqual({
      type: 'bots.changed',
      botId: wipe.id,
      change: 'deleted',
    });
  });

  it('the lead bot cannot be archived or deleted', async () => {
    const lead = h.repos.bots.create({ name: 'Agent A', engine: 'claude', isLead: true });
    const a = await app.inject({ method: 'POST', url: `/api/bots/${lead.id}/archive` });
    expect(a.statusCode).toBe(409);
    expect(a.json().error.code).toBe('lead_protected');
    const d = await app.inject({
      method: 'DELETE',
      url: `/api/bots/${lead.id}`,
      payload: { confirmName: 'Agent A' },
    });
    expect(d.statusCode).toBe(409);
    expect((await app.inject({ url: '/api/bots' })).json<BotView[]>()[0]!.id).toBe(lead.id);
  });

  it('duplicate copies the profile with a fresh slug, DM thread and token', async () => {
    const src = (
      await create({
        name: 'Tester',
        engine: 'codex',
        model: 'gpt-5',
        instructions: 'Write tests first.',
        avatarColor: '#ff0000',
        settings: { cpus: 1, memoryMb: 1024, idleTimeoutMin: 10, flags: {} },
      })
    ).json<BotView>();
    const res = await app.inject({ method: 'POST', url: `/api/bots/${src.id}/duplicate`, payload: {} });
    expect(res.statusCode).toBe(201);
    const copy = res.json<BotView>();
    expect(copy).toMatchObject({
      name: 'Tester (copy)',
      slug: 'tester-copy',
      engine: 'codex',
      model: 'gpt-5',
      instructions: 'Write tests first.',
      avatarColor: '#ff0000',
      settings: src.settings,
    });
    expect(copy.id).not.toBe(src.id);
    expect(copy.dmThreadId).not.toBe(src.dmThreadId);
    expect(readFileSync(tokenFile(copy.id), 'utf8')).not.toBe(readFileSync(tokenFile(src.id), 'utf8'));

    const named = await app.inject({
      method: 'POST',
      url: `/api/bots/${src.id}/duplicate`,
      payload: { name: 'Tester 2' },
    });
    expect(named.json<BotView>().name).toBe('Tester 2');
  });

  it('provision re-issues a token after the home lost it', async () => {
    const bot = (await create({ name: 'Wiped', engine: 'claude' })).json<BotView>();
    const before = h.repos.bots.get(bot.id)!.mcpTokenHash;
    writeFileSync(tokenFile(bot.id), 'agm_tampered\n');
    bots.provision(bot.id);
    const after = h.repos.bots.get(bot.id)!.mcpTokenHash;
    expect(after).not.toBe(before);
    expect(verifyMcpToken(readFileSync(tokenFile(bot.id), 'utf8').trim(), after)).toBe(true);
  });
});
