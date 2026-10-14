import { rmSync } from 'node:fs';
import type { ConnectorView } from '@agenta/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { ConnectorService } from '../../src/connectors/service';
import { renderInstructionFiles } from '../../src/engines/prompt';
import { buildServer } from '../../src/server';
import { type Harness, makeHarness } from '../runs/helpers';

// Built at runtime so pnpm check:secrets doesn't flag the fake.
const FAKE_GH_TOKEN = `${'github'}_pat_${'F'.repeat(30)}`;

describe('connectors (F29)', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const };
  let h: Harness;
  let env: Record<string, string | undefined>;
  let connectors: ConnectorService;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let alice: string;
  let bob: string;

  beforeEach(async () => {
    h = makeHarness();
    env = { GITHUB_TOKEN: FAKE_GH_TOKEN };
    connectors = new ConnectorService({ repos: h.repos, secrets: { get: (n) => env[n] } });
    app = await buildServer(config, { repos: h.repos, connectors });
    alice = h.bot('Alice');
    bob = h.bot('Bob');
  });

  afterEach(async () => {
    await app.close();
    h.db.$client.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  const github = () => connectors.list().find((c) => c.type === 'github')!;

  it('creates the GitHub connector disabled, with nobody allowed', () => {
    expect(github()).toMatchObject({
      enabled: false,
      tokenEnv: 'GITHUB_TOKEN',
      tokenPresent: true,
      botIds: [],
    });
    expect(connectors.list()).toHaveLength(1); // not created twice
    expect(connectors.execEnv(alice)).toEqual({});
  });

  it('puts GH_TOKEN only in the exec env of enabled bots', () => {
    const id = github().id;
    connectors.update(id, { botIds: [alice] });
    expect(connectors.execEnv(alice)).toEqual({}); // connector still off
    connectors.update(id, { enabled: true });
    expect(connectors.execEnv(alice)).toEqual({ GH_TOKEN: FAKE_GH_TOKEN });
    expect(connectors.forBot(alice)).toEqual(['github']);
    expect(connectors.execEnv(bob)).toEqual({});
    expect(connectors.forBot(bob)).toEqual([]);

    connectors.update(id, { botIds: [bob] });
    expect(connectors.execEnv(alice)).toEqual({});
    expect(connectors.execEnv(bob)).toEqual({ GH_TOKEN: FAKE_GH_TOKEN });
  });

  it('gives nobody a token when GITHUB_TOKEN is missing, and picks up a new one at once', () => {
    const id = github().id;
    connectors.update(id, { enabled: true, botIds: [alice] });
    env.GITHUB_TOKEN = undefined;
    expect(github().tokenPresent).toBe(false);
    expect(connectors.execEnv(alice)).toEqual({});
    expect(connectors.forBot(alice)).toEqual([]);
    env.GITHUB_TOKEN = 'github_pat_NEW';
    expect(connectors.execEnv(alice)).toEqual({ GH_TOKEN: 'github_pat_NEW' });
  });

  it('drops a deleted bot from the connector', () => {
    const id = github().id;
    connectors.update(id, { enabled: true, botIds: [alice, bob] });
    h.repos.bots.delete(alice);
    expect(github().botIds).toEqual([bob]);
  });

  it('serves GET/PATCH /api/connectors without ever returning the token', async () => {
    const list = (await app.inject({ url: '/api/connectors' })).json<ConnectorView[]>();
    expect(JSON.stringify(list)).not.toContain(FAKE_GH_TOKEN);
    const id = list[0]!.id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/connectors/${id}`,
      payload: { enabled: true, botIds: [alice] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, botIds: [alice], tokenPresent: true });
    expect(res.body).not.toContain(FAKE_GH_TOKEN);

    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/connectors/${id}`,
      payload: { botIds: ['bot_nope'] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_bot');
    expect(github().botIds).toEqual([alice]); // unchanged

    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/connectors/${id}`,
      payload: { enabled: 'yes' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('invalid_body');

    const missing = await app.inject({ method: 'PATCH', url: '/api/connectors/con_nope', payload: {} });
    expect(missing.statusCode).toBe(404);
  });

  it('adds the GitHub rules to the instruction files only for bots with the connector', () => {
    const bot = { name: 'Alice', role: '', instructions: '', isLead: false };
    const without = renderInstructionFiles(bot);
    expect(without['CLAUDE.md']).not.toContain('## GitHub');
    const withGh = renderInstructionFiles(bot, [], [], ['github']);
    for (const text of [withGh['CLAUDE.md'], withGh['AGENTS.md']]) {
      expect(text).toContain('## GitHub');
      expect(text).toContain('gh auth setup-git');
      expect(text).toMatch(/request_approval.*`git push`; open, merge or close a pull request; comment/);
      expect(text).not.toContain(FAKE_GH_TOKEN);
    }
  });
});
