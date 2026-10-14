import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GuardCheckResponse, GuardTermView } from '@agenta/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotService } from '../../src/bots/service';
import { loadConfig } from '../../src/config';
import { MockEngine } from '../../src/engines/mock';
import { FilesService } from '../../src/files/service';
import { GuardService } from '../../src/guard/service';
import { MemoryService } from '../../src/memories/service';
import { buildServer } from '../../src/server';
import { ThreadService, inboxDir } from '../../src/threads/service';
import { type Harness, makeHarness, silent } from '../runs/helpers';

describe('confidentiality guard (F24)', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const };
  let h: Harness;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let botsDir: string;
  let botId: string;
  let dm: string;
  const warnings: { obj: object; msg?: string }[] = [];

  beforeEach(async () => {
    warnings.length = 0;
    h = makeHarness({ adapters: [new MockEngine({ slowMs: 60_000, tickMs: 1 })] });
    botsDir = join(h.dir, 'bots');
    const guard = new GuardService({
      repos: h.repos,
      log: { warn: (obj, msg) => warnings.push({ obj, msg }) },
    });
    const bots = new BotService({ repos: h.repos, bus: h.bus, log: silent, botsDir, runs: h.service });
    const threads = new ThreadService({
      repos: h.repos,
      bus: h.bus,
      log: silent,
      botsDir,
      bots,
      runs: h.service,
      guard,
    });
    const files = new FilesService({
      repos: h.repos,
      bus: h.bus,
      log: silent as never,
      botsDir,
      sharedDir: join(h.dir, 'shared'),
      guard,
    });
    const memories = new MemoryService({ repos: h.repos, log: silent });
    app = await buildServer(config, {
      repos: h.repos,
      runs: h.service,
      bots,
      threads,
      files,
      memories,
      guard,
    });
    const bot = bots.create({ name: 'Helper', engine: 'mock' });
    botId = bot.id;
    dm = h.repos.threads.findDm(bot.id)!.id;
  });
  afterEach(async () => {
    await app.close();
    h.close();
  });

  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  const addTerm = (term: string, kind = 'literal') =>
    post('/api/guard/terms', { term, kind, note: 'client' });
  const raw = (url: string, body: string) =>
    app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/octet-stream' },
      payload: body,
    });

  it('manages guard terms and validates regexes', async () => {
    const created = await addTerm('Globex');
    expect(created.statusCode).toBe(201);
    const term = created.json<GuardTermView>();
    expect(term).toMatchObject({ term: 'Globex', kind: 'literal', note: 'client' });
    expect((await addTerm('(', 'regex')).json().error.code).toBe('invalid_body');
    expect((await app.inject({ url: '/api/guard/terms' })).json<GuardTermView[]>().map((t) => t.id)).toEqual([
      term.id,
    ]);
    expect((await app.inject({ method: 'DELETE', url: `/api/guard/terms/${term.id}` })).statusCode).toBe(204);
    const missing = await app.inject({ method: 'DELETE', url: `/api/guard/terms/${term.id}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');
  });

  it('checks text against detectors and guard terms and returns a redacted copy', async () => {
    await addTerm('Globex');
    const res = await post('/api/guard/check', { text: 'Globex db at 10.0.0.5' });
    const body = res.json<GuardCheckResponse>();
    expect(body.findings.map((f) => f.kind)).toEqual(['guard_term', 'ip_address']);
    expect(body.redacted).toBe('[REDACTED:guard_term] db at [REDACTED:ip_address]');
    expect((await post('/api/guard/check', { text: 'all clear' })).json()).toEqual({
      findings: [],
      redacted: 'all clear',
    });
  });

  it('blocks flagged inbox and Files uploads unless the owner uploads anyway (logged)', async () => {
    await addTerm('Globex');
    const blocked = await raw(`/api/bots/${botId}/inbox?name=notes.txt`, 'Globex roadmap');
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error).toMatchObject({ code: 'guard_blocked' });
    expect(blocked.json().error.message).toContain('guard term (client)');
    expect(blocked.json().error.message).not.toContain('Globex');
    expect(existsSync(join(inboxDir(botsDir, botId), 'notes.txt'))).toBe(false);

    const forced = await raw(`/api/bots/${botId}/inbox?name=notes.txt&allowFlagged=true`, 'Globex roadmap');
    expect(forced.statusCode).toBe(201);
    expect(warnings).toEqual([
      { obj: { botId, where: 'inbox', kinds: ['guard_term'] }, msg: 'guard override: upload' },
    ]);

    const files = `/api/bots/${botId}/files/upload?root=home&path=&name=a.txt`;
    expect((await raw(files, 'Globex')).statusCode).toBe(422);
    expect((await raw(`${files}&allowFlagged=1`, 'Globex')).statusCode).toBe(201);
    // Binary files are not scanned.
    expect((await raw(`/api/bots/${botId}/inbox?name=x.bin`, 'Globex\u0000')).statusCode).toBe(201);
  });

  it('logs "Send anyway" without the text', async () => {
    await addTerm('Globex');
    const res = await post(`/api/threads/${dm}/messages`, { content: 'Globex plan', guardOverride: true });
    expect(res.statusCode).toBe(201);
    expect(warnings).toEqual([
      { obj: { threadId: dm, kinds: ['guard_term'] }, msg: 'guard override: message' },
    ]);
  });

  it('memory saves refuse guard terms', async () => {
    await addTerm('Globex');
    const res = await post('/api/memories', {
      scope: 'shared',
      title: 'Client',
      contentMd: 'We work for Globex',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain('guard term');
  });
});
