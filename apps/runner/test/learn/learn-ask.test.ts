import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HandoffBrief, LearnRequestResponse, WorkSplit } from '@agenta/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotService } from '../../src/bots/service';
import { loadConfig } from '../../src/config';
import { MockEngine } from '../../src/engines/mock';
import { LearnService } from '../../src/learn/service';
import { PlatformTools } from '../../src/mcp/tools';
import { buildServer } from '../../src/server';
import { ThreadService } from '../../src/threads/service';
import { type Harness, makeHarness, silent } from '../runs/helpers';

// Split so the repo's own secret scanner does not flag this fake key.
const FAKE_KEY = ['sk', 'ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345'].join('-');

describe('learn session 2: work split, weekly review, briefs, ask why (F23)', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const };
  let h: Harness;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let learn: LearnService;
  let threads: ThreadService;
  let sharedDir: string;
  let leadId: string;
  let devId: string;
  const now = new Date('2026-10-14T12:00:00.000Z'); // a Wednesday

  beforeEach(async () => {
    h = makeHarness({ adapters: [new MockEngine({ slowMs: 60_000, tickMs: 1 })] });
    const botsDir = join(h.dir, 'bots');
    sharedDir = join(h.dir, 'shared');
    const bots = new BotService({ repos: h.repos, bus: h.bus, log: silent, botsDir, runs: h.service });
    threads = new ThreadService({ repos: h.repos, bus: h.bus, log: silent, botsDir, bots, runs: h.service });
    learn = new LearnService({ repos: h.repos, bus: h.bus, log: silent, sharedDir, threads, now: () => now });
    app = await buildServer(config, { repos: h.repos, runs: h.service, bots, threads, learn });
    leadId = bots.create({ name: 'Agent A', engine: 'mock' }).id;
    h.repos.bots.update(leadId, { isLead: true });
    devId = bots.create({ name: 'Dev', engine: 'mock' }).id;
  });
  afterEach(async () => {
    await app.close();
    h.close();
  });

  it('work split counts done tasks per UTC week by executor; mixed counts half', async () => {
    const done = (executedBy: 'agent' | 'human' | 'mixed', updatedAt: string) => {
      const t = h.repos.tasks.create({ title: 't', executedBy });
      h.db.$client
        .prepare('update tasks set status = ?, updated_at = ? where id = ?')
        .run('done', updatedAt, t.id);
    };
    done('agent', '2026-10-13T08:00:00.000Z'); // this week (Mon 12 Oct)
    done('agent', '2026-10-14T08:00:00.000Z');
    done('mixed', '2026-10-12T00:00:00.000Z');
    done('human', '2026-10-11T23:59:00.000Z'); // last week
    h.repos.tasks.create({ title: 'not done', executedBy: 'human' });
    const res = (await app.inject({ url: '/api/learn/work-split?weeks=2' })).json<WorkSplit>();
    expect(res.target).toBe(0.8);
    expect(res.weeks).toEqual([
      { weekStart: '2026-10-05T00:00:00.000Z', agent: 0, human: 1, mixed: 0, agentShare: 0 },
      { weekStart: '2026-10-12T00:00:00.000Z', agent: 2, human: 0, mixed: 1, agentShare: 2.5 / 3 },
    ]);
  });

  it('weekly review asks Agent A in its DM with the week; review questions are due today', async () => {
    h.repos.decisions.create({ title: 'Use SQLite' });
    const res = await app.inject({ method: 'POST', url: '/api/learn/weekly-review' });
    expect(res.statusCode).toBe(201);
    const r = res.json<LearnRequestResponse>();
    expect(r.threadId).toBe(h.repos.threads.findDm(leadId)!.id);
    const run = h.repos.runs.get(r.runId)!;
    expect(run.botId).toBe(leadId);
    expect(run.prompt).toContain('ADR-0001 Use SQLite');
    expect(run.prompt).toContain('review_today: true');

    const tools = new PlatformTools({ repos: h.repos, threads, bus: h.bus, log: silent, learn });
    const lead = h.repos.bots.get(leadId)!;
    const l = (await tools.call(lead, 'add_lesson', {
      topic: 'weekly-review',
      lesson: 'Q? A.',
      review_today: true,
    })) as {
      next_review_at: string;
    };
    expect(l.next_review_at).toBe(now.toISOString());
  });

  it('carry-over brief: asked in the task thread; save_handoff_brief is guard-checked; list withholds flagged files', async () => {
    const task = h.repos.tasks.create({
      title: 'Build login',
      descriptionMd: 'OAuth flow',
      originThreadId: h.repos.threads.findDm(devId)!.id,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/learn/carry-over-brief',
      payload: { taskId: task.id },
    });
    expect(res.statusCode).toBe(201);
    const r = res.json<LearnRequestResponse>();
    expect(r.threadId).toBe(task.originThreadId);
    expect(h.repos.runs.get(r.runId)!.prompt).toContain('save_handoff_brief');
    expect(
      (await app.inject({ method: 'POST', url: '/api/learn/carry-over-brief', payload: {} })).statusCode,
    ).toBe(400);

    const tools = new PlatformTools({ repos: h.repos, threads, bus: h.bus, log: silent, learn });
    const lead = h.repos.bots.get(leadId)!;
    await expect(
      tools.call(lead, 'save_handoff_brief', { title: 'Login', content: `Use ${FAKE_KEY}` }),
    ).rejects.toThrow(/Anthropic API key/);
    expect(
      await tools.call(lead, 'save_handoff_brief', { title: 'Login', content: '**What to do:** build it.' }),
    ).toEqual({
      path: '/shared/handoff/2026-10-14-login.md',
      title: 'Login',
    });
    // A file edited by hand to include a secret is withheld.
    mkdirSync(join(sharedDir, 'handoff'), { recursive: true });
    writeFileSync(join(sharedDir, 'handoff', 'leak.md'), `# Leak\n\n${FAKE_KEY}\n`);
    const briefs = (await app.inject({ url: '/api/learn/briefs' })).json<HandoffBrief[]>();
    const byName = Object.fromEntries(briefs.map((b) => [b.name, b]));
    expect(byName['2026-10-14-login.md']).toMatchObject({
      guard: { ok: true },
      contentMd: expect.stringContaining('build it'),
    });
    expect(byName['leak.md']).toMatchObject({ guard: { ok: false }, contentMd: '' });
  });

  it('ask why: Agent A answers in the same thread, even a DM it is not in', async () => {
    const dm = h.repos.threads.findDm(devId)!.id;
    const msg = h.repos.messages.create({
      threadId: dm,
      authorType: 'bot',
      authorBotId: devId,
      contentMd: 'Used a queue.',
    });
    const res = await app.inject({ method: 'POST', url: `/api/threads/${dm}/messages/${msg.id}/ask-why` });
    expect(res.statusCode).toBe(201);
    const run = h.repos.runs.get(res.json<{ runs: { id: string }[] }>().runs[0]!.id)!;
    expect(run).toMatchObject({ botId: leadId, threadId: dm });
    expect(run.prompt).toContain("Dev's message");
    expect(run.prompt).toContain('> Used a queue.');
    const user = h.repos.messages.create({ threadId: dm, authorType: 'user', contentMd: 'hi' });
    expect(
      (await app.inject({ method: 'POST', url: `/api/threads/${dm}/messages/${user.id}/ask-why` }))
        .statusCode,
    ).toBe(404);
  });
});
