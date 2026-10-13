import type { EngineQueueStateResponse } from '@agenta/shared';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyLiveEvent } from '@/lib/live-cache';
import { queryKeys } from '@/lib/query-keys';
import { type MessagesData, flattenPages } from '@/lib/threads';
import type { RunnerStatus } from '@/lib/runner';

describe('applyLiveEvent', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient();
  });
  const stale = (key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated;

  it('patches engine limits into the engine-state query', () => {
    qc.setQueryData<EngineQueueStateResponse>(queryKeys.engineState, {
      override: 'mock',
      engines: [
        { engine: 'claude', limitedUntil: null },
        { engine: 'mock', limitedUntil: null },
      ],
    });
    applyLiveEvent(qc, { type: 'engine.state', engine: 'mock', limitedUntil: '2026-10-13T14:05:00.000Z' });
    applyLiveEvent(qc, { type: 'engine.state', engine: 'codex', limitedUntil: null });
    expect(qc.getQueryData(queryKeys.engineState)).toEqual({
      override: 'mock',
      engines: [
        { engine: 'claude', limitedUntil: null },
        { engine: 'mock', limitedUntil: '2026-10-13T14:05:00.000Z' },
        { engine: 'codex', limitedUntil: null },
      ],
    });
  });

  it('replaces the docker part of a healthy runner status', () => {
    const status: RunnerStatus = {
      state: 'ok',
      health: { ok: true, version: '0.1.0', uptime: 5, docker: { ok: true, version: '28', image: true } },
    };
    qc.setQueryData(queryKeys.runnerStatus, status);
    applyLiveEvent(qc, { type: 'docker.state', ok: false, error: 'socket gone' });
    expect(qc.getQueryData<RunnerStatus>(queryKeys.runnerStatus)).toEqual({
      ...status,
      health: { ...status.health, docker: { ok: false, error: 'socket gone' } },
    });

    const down: RunnerStatus = { state: 'down', reason: 'x' };
    qc.setQueryData(queryKeys.runnerStatus, down);
    applyLiveEvent(qc, { type: 'docker.state', ok: true });
    expect(qc.getQueryData(queryKeys.runnerStatus)).toEqual({ state: 'down', reason: 'x' });
  });

  it('patches bot status in every bot list and the detail', () => {
    const list = [
      { id: 'b1', status: 'stopped', name: 'A' },
      { id: 'b2', status: 'stopped', name: 'B' },
    ];
    qc.setQueryData(queryKeys.botList('exclude'), list);
    qc.setQueryData(queryKeys.botList('include'), list);
    qc.setQueryData(queryKeys.bot('b1'), { id: 'b1', status: 'stopped', name: 'A' });
    applyLiveEvent(qc, { type: 'bot.status', botId: 'b1', status: 'running' });
    for (const key of [queryKeys.botList('exclude'), queryKeys.botList('include')]) {
      expect(qc.getQueryData(key)).toEqual([
        { id: 'b1', status: 'running', name: 'A' },
        { id: 'b2', status: 'stopped', name: 'B' },
      ]);
    }
    expect(qc.getQueryData(queryKeys.bot('b1'))).toEqual({ id: 'b1', status: 'running', name: 'A' });
  });

  it('bots.changed invalidates bot lists and that bot only', () => {
    qc.setQueryData(queryKeys.botList('exclude'), []);
    qc.setQueryData(queryKeys.bot('b1'), { id: 'b1' });
    qc.setQueryData(queryKeys.bot('other'), { id: 'other' });
    applyLiveEvent(qc, { type: 'bots.changed', botId: 'b1', change: 'updated' });
    expect(qc.getQueryState(queryKeys.botList('exclude'))!.isInvalidated).toBe(true);
    expect(qc.getQueryState(queryKeys.bot('b1'))!.isInvalidated).toBe(true);
    expect(qc.getQueryState(queryKeys.bot('other'))!.isInvalidated).toBe(false);

    // Deleted: lists refresh, the detail is left alone (a refetch would only 404).
    qc.setQueryData(queryKeys.botList('exclude'), []);
    qc.setQueryData(queryKeys.bot('b2'), { id: 'b2' });
    applyLiveEvent(qc, { type: 'bots.changed', botId: 'b2', change: 'deleted' });
    expect(qc.getQueryState(queryKeys.botList('exclude'))!.isInvalidated).toBe(true);
    expect(qc.getQueryState(queryKeys.bot('b2'))!.isInvalidated).toBe(false);
  });

  it('patches run status and invalidates run lists only', () => {
    qc.setQueryData(queryKeys.run('r1'), { id: 'r1', status: 'queued', error: null });
    qc.setQueryData(queryKeys.runs, [{ id: 'r1', status: 'queued' }]);
    applyLiveEvent(qc, {
      type: 'run.updated',
      runId: 'r1',
      botId: 'b1',
      threadId: null,
      taskId: null,
      status: 'failed',
      error: 'boom',
    });
    expect(qc.getQueryData(queryKeys.run('r1'))).toEqual({ id: 'r1', status: 'failed', error: 'boom' });
    expect(stale(queryKeys.runs)).toBe(true);
    expect(stale(queryKeys.run('r1'))).toBe(false);
  });

  it('patches the status of a run in every cached run list', () => {
    qc.setQueryData(queryKeys.threadRuns('t1'), [
      { id: 'r1', status: 'running', error: null },
      { id: 'r0', status: 'succeeded', error: null },
    ]);
    applyLiveEvent(qc, {
      type: 'run.updated',
      runId: 'r1',
      botId: 'b1',
      threadId: 't1',
      taskId: null,
      status: 'cancelled',
      error: null,
    });
    expect(qc.getQueryData(queryKeys.threadRuns('t1'))).toEqual([
      { id: 'r1', status: 'cancelled', error: null },
      { id: 'r0', status: 'succeeded', error: null },
    ]);
  });

  it('grows a cached message in place and appends new ones to the newest page', () => {
    const key = queryKeys.threadMessages('t1');
    const msg = (id: string, contentMd: string) => ({
      id,
      threadId: 't1',
      authorType: 'bot' as const,
      authorBotId: 'b1',
      contentMd,
      runId: 'r1',
      mentions: [],
      createdAt: '2026-10-13T10:00:00.000Z',
    });
    qc.setQueryData<MessagesData>(key, {
      pages: [
        { messages: [msg('m1', 'Hel')], hasMore: true },
        { messages: [msg('m0', 'old')], hasMore: false },
      ],
      pageParams: [undefined, 'm1'],
    });
    const base = { threadId: 't1', runId: 'r1', authorBotId: 'b1' };
    applyLiveEvent(qc, { type: 'message.updated', messageId: 'm1', contentMd: 'Hello', ...base });
    expect(flattenPages(qc.getQueryData(key)).map((m) => m.contentMd)).toEqual(['old', 'Hello']);
    expect(stale(key)).toBe(false);

    const created = {
      type: 'message.created' as const,
      messageId: 'm2',
      contentMd: 'Hi',
      authorType: 'user' as const,
      createdAt: '2026-10-13T10:01:00.000Z',
      ...base,
    };
    applyLiveEvent(qc, created);
    applyLiveEvent(qc, created); // repeats are idempotent
    expect(flattenPages(qc.getQueryData(key)).map((m) => m.id)).toEqual(['m0', 'm1', 'm2']);
    expect(stale(key)).toBe(false);

    // An event without the full message (older runner) refetches instead.
    applyLiveEvent(qc, { type: 'message.created', messageId: 'm3', contentMd: 'x', ...base });
    expect(stale(key)).toBe(true);
  });

  it('ignores messages for threads nobody has loaded', () => {
    applyLiveEvent(qc, {
      type: 'message.created',
      threadId: 't9',
      messageId: 'm1',
      runId: null,
      authorBotId: null,
      contentMd: 'x',
    });
    expect(qc.getQueryData(queryKeys.threadMessages('t9'))).toBeUndefined();
  });
});
