import type { ApprovalView } from '@agenta/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalService } from '../../src/approvals/service';
import { loadConfig } from '../../src/config';
import { PlatformTools } from '../../src/mcp/tools';
import { buildServer } from '../../src/server';
import { type Harness, makeHarness, silent } from '../runs/helpers';

describe('approvals (F25)', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const };
  let h: Harness;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let tools: PlatformTools;
  let now: Date;
  const events: unknown[] = [];

  beforeEach(async () => {
    events.length = 0;
    now = new Date('2026-10-14T10:00:00.000Z');
    h = makeHarness();
    h.bus.subscribe('global', (e) => events.push(e));
    const approvals = new ApprovalService({ repos: h.repos, bus: h.bus, log: silent, now: () => now });
    const threads = { postAsBot: () => undefined, askBot: () => undefined } as never;
    tools = new PlatformTools({ repos: h.repos, threads, log: silent, approvals });
    app = await buildServer(config, { repos: h.repos, runs: h.service, approvals });
  });
  afterEach(async () => {
    await app.close();
    h.close();
  });

  const bot = (name = 'Pusher') => h.repos.bots.create({ name, engine: 'mock' });
  const request = (b = bot()) =>
    tools.call(b, 'request_approval', {
      action: 'Push to main',
      details: 'two commits',
      risk: 'high',
    }) as Promise<{
      approval_id: string;
    }>;
  const check = (b: ReturnType<typeof bot>, id: string) =>
    tools.call(b, 'check_approval', { approval_id: id }) as Promise<{ status: string; note: string | null }>;
  const list = async (status?: string) =>
    (await app.inject({ url: `/api/approvals${status ? `?status=${status}` : ''}` })).json<ApprovalView[]>();

  it('request → listed as pending with a notification → approve with a note → check_approval says approved', async () => {
    const b = bot();
    const { approval_id } = await request(b);
    expect(await check(b, approval_id)).toMatchObject({ status: 'pending', note: null });
    const pending = await list('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ botId: b.id, action: 'Push to main', risk: 'high' });
    expect(h.repos.notifications.list()[0]).toMatchObject({ kind: 'approval.requested' });
    expect(events).toContainEqual({ type: 'approval.changed', approvalId: approval_id });

    const res = await app.inject({
      method: 'POST',
      url: `/api/approvals/${approval_id}/decide`,
      payload: { status: 'approved', note: 'only main' },
    });
    expect(res.statusCode).toBe(200);
    expect(await check(b, approval_id)).toMatchObject({ status: 'approved', note: 'only main' });
    expect(await list('pending')).toHaveLength(0);

    const again = await app.inject({
      method: 'POST',
      url: `/api/approvals/${approval_id}/decide`,
      payload: { status: 'denied' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_decided');
  });

  it('expires pending approvals after 24 hours (fake clock); expired ones cannot be decided', async () => {
    const b = bot();
    const { approval_id } = await request(b);
    now = new Date(Date.now() + 23 * 3_600_000);
    expect(await check(b, approval_id)).toMatchObject({ status: 'pending' });
    now = new Date(Date.now() + 24 * 3_600_000 + 1_000);
    expect(await check(b, approval_id)).toMatchObject({ status: 'expired' });
    expect((await list())[0]).toMatchObject({ status: 'expired', decidedAt: now.toISOString() });
    const res = await app.inject({
      method: 'POST',
      url: `/api/approvals/${approval_id}/decide`,
      payload: { status: 'approved' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('bots only see their own approvals; bad input is a typed 400 or 404', async () => {
    const { approval_id } = await request(bot('A'));
    await expect(check(bot('B'), approval_id)).rejects.toThrow(/No approval/);
    const bad = await app.inject({
      method: 'POST',
      url: `/api/approvals/${approval_id}/decide`,
      payload: { status: 'expired' },
    });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ url: '/api/approvals/apr_nope' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/approvals?status=nope' })).statusCode).toBe(400);
  });
});
