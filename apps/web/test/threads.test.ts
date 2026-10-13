import type { EngineQueueStateResponse, LiveEvent, MessageView, RunView } from '@agenta/shared';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_STREAM,
  type MessagesData,
  applyStreamEvent,
  buildTranscript,
  flattenPages,
  runState,
  streamText,
  upsertMessage,
} from '@/lib/threads';

let t = 0;
const at = () => new Date(Date.UTC(2026, 9, 13, 10, 0, t++)).toISOString();

function msg(id: string, p: Partial<MessageView> = {}): MessageView {
  return {
    id,
    threadId: 't1',
    authorType: 'user',
    authorBotId: null,
    contentMd: id,
    runId: null,
    mentions: [],
    createdAt: at(),
    ...p,
  };
}
function run(id: string, p: Partial<RunView> = {}): RunView {
  return {
    id,
    botId: 'b1',
    threadId: 't1',
    taskId: null,
    trigger: 'user',
    status: 'succeeded',
    engine: 'mock',
    createdAt: at(),
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    error: null,
    usage: null,
    retryOfRunId: null,
    ...p,
  };
}
const shape = (items: ReturnType<typeof buildTranscript>) =>
  items.map((i) => (i.kind === 'message' ? i.message.id : `${i.run.id}${i.reply ? `<${i.reply.id}>` : ''}`));

describe('buildTranscript', () => {
  it('places each run after the user message that started it and folds in its reply', () => {
    const u1 = msg('u1', { runId: 'r1' });
    const r1 = run('r1');
    const b1 = msg('b1', { authorType: 'bot', authorBotId: 'b1', runId: 'r1' });
    const u2 = msg('u2', { runId: 'r2' });
    const r2 = run('r2', { status: 'running' });
    expect(shape(buildTranscript([u1, b1, u2], [r2, r1]))).toEqual(['u1', 'r1<b1>', 'u2', 'r2']);
  });

  it('puts a usage-limit retry right after its original run', () => {
    const u1 = msg('u1', { runId: 'r1' });
    const r1 = run('r1', { status: 'limited' });
    const u2 = msg('u2', { runId: 'r2' });
    const r2 = run('r2', { status: 'queued' });
    const r3 = run('r3', { status: 'queued', retryOfRunId: 'r1' });
    expect(shape(buildTranscript([u1, u2], [r3, r2, r1]))).toEqual(['u1', 'r1', 'r3', 'u2', 'r2']);
  });

  it('keeps replies whose runs are not loaded as plain messages, and anchors orphan runs at their reply', () => {
    const old = msg('b0', { authorType: 'bot', authorBotId: 'b1', runId: 'r-gone' });
    const reply = msg('b1', { authorType: 'bot', authorBotId: 'b1', runId: 'r1' });
    const r1 = run('r1'); // its user message is on an older page
    expect(shape(buildTranscript([old, reply], [r1]))).toEqual(['b0', 'r1<b1>']);
  });

  it('shows runs newer than the loaded history at the end and drops older ones', () => {
    const r0 = run('r0'); // before every loaded message
    const u = msg('u1');
    const r1 = run('r1', { status: 'queued' }); // e.g. started by a schedule
    expect(shape(buildTranscript([u], [r1, r0]))).toEqual(['u1', 'r1']);
    expect(shape(buildTranscript([], [r1]))).toEqual(['r1']);
  });
});

describe('message cache helpers', () => {
  it('appends new messages to the newest page and replaces known ones', () => {
    const data: MessagesData = {
      pages: [
        { messages: [msg('m2')], hasMore: true },
        { messages: [msg('m1')], hasMore: false },
      ],
      pageParams: [undefined, 'm2'],
    };
    const added = upsertMessage(data, msg('m3'));
    expect(flattenPages(added).map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    const replaced = upsertMessage(added, { ...msg('m1'), contentMd: 'edited' });
    expect(flattenPages(replaced).map((m) => m.contentMd)).toEqual(['edited', 'm2', 'm3']);
    expect(flattenPages(undefined)).toEqual([]);
  });
});

describe('run stream', () => {
  const ev = (
    seq: number,
    event: Extract<LiveEvent, { type: 'run.event' }>['event'],
    runId = 'r1',
  ): LiveEvent => ({
    type: 'run.event',
    runId,
    seq,
    event,
    createdAt: at(),
  });

  it('streams deltas, settles on text.final, ignores repeats and other runs', () => {
    let s = EMPTY_STREAM;
    const events: LiveEvent[] = [
      ev(1, { type: 'run.started', engine: 'mock' }),
      ev(2, { type: 'text.delta', text: 'Hello ' }),
      ev(3, { type: 'text.delta', text: 'there' }),
    ];
    for (const e of events) s = applyStreamEvent(s, 'r1', e);
    expect(streamText(s)).toBe('Hello there');
    s = applyStreamEvent(s, 'r1', ev(3, { type: 'text.delta', text: 'there' })); // replayed duplicate
    s = applyStreamEvent(s, 'r1', ev(9, { type: 'text.delta', text: 'X' }, 'r2'));
    expect(streamText(s)).toBe('Hello there');
    s = applyStreamEvent(s, 'r1', ev(4, { type: 'text.final', text: 'Hello there' }));
    s = applyStreamEvent(s, 'r1', ev(5, { type: 'text.delta', text: 'More' }));
    expect(streamText(s)).toBe('Hello there\n\nMore');
    s = applyStreamEvent(s, 'r1', ev(6, { type: 'error', message: 'boom' }));
    expect(s.errors).toEqual(['boom']);
    expect(s.lastSeq).toBe(6);
  });
});

describe('runState', () => {
  const now = Date.parse('2026-10-13T10:00:00.000Z');
  const engines = (limitedUntil: string | null): EngineQueueStateResponse => ({
    override: 'mock',
    engines: [{ engine: 'mock', limitedUntil }],
  });

  it('describes each status', () => {
    expect(runState(run('r', { status: 'queued' }), engines(null), false, now)).toMatchObject({
      label: 'Queued',
      stoppable: true,
    });
    const limited = runState(run('r', { status: 'queued' }), engines('2026-10-13T10:30:00.000Z'), false, now);
    expect(limited?.label).toMatch(/^Limited — resumes at \d{2}:\d{2}$/);
    expect(limited?.tone).toBe('warn');
    // An expired pause is not shown.
    expect(
      runState(run('r', { status: 'queued' }), engines('2026-10-13T09:00:00.000Z'), false, now)?.label,
    ).toBe('Queued');
    expect(runState(run('r', { status: 'running' }), undefined, false, now)).toMatchObject({
      typing: true,
      stoppable: true,
    });
    expect(runState(run('r', { status: 'cancelled' }), undefined, false, now)?.label).toBe('Stopped');
    expect(runState(run('r', { status: 'failed', error: 'boom' }), undefined, false, now)).toMatchObject({
      label: 'Failed: boom',
      tone: 'error',
    });
    expect(
      runState(run('r', { status: 'limited' }), engines('2026-10-13T10:30:00.000Z'), true, now)?.label,
    ).toMatch(/^Usage limit reached — this turn runs again at \d{2}:\d{2}$/);
    expect(runState(run('r', { status: 'succeeded' }), undefined, false, now)).toBeNull();
  });
});
