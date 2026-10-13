import type { EngineQueueStateResponse, LiveEvent, MessageView, RunView } from '@agenta/shared';
import { describe, expect, it } from 'vitest';
import { buildTimeline, timelineText } from '@/lib/timeline';
import {
  insertMention,
  workingBots,
  mentionAt,
  mentionCandidates,
  EMPTY_STREAM,
  type MessagesData,
  applyStreamEvent,
  buildTranscript,
  flattenPages,
  runState,
  createRunEventsLoader,
  lastUserMessage,
  retryableRun,
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
    const text = () => timelineText(buildTimeline(s.items));
    for (const e of events) s = applyStreamEvent(s, 'r1', e);
    expect(text()).toBe('Hello there');
    expect(s.items).toHaveLength(2); // deltas merged
    s = applyStreamEvent(s, 'r1', ev(3, { type: 'text.delta', text: 'there' })); // replayed duplicate
    s = applyStreamEvent(s, 'r1', ev(9, { type: 'text.delta', text: 'X' }, 'r2'));
    expect(text()).toBe('Hello there');
    s = applyStreamEvent(s, 'r1', ev(4, { type: 'text.final', text: 'Hello there' }));
    s = applyStreamEvent(s, 'r1', ev(5, { type: 'text.delta', text: 'More' }));
    expect(text()).toBe('Hello there\n\nMore');
    s = applyStreamEvent(s, 'r1', ev(6, { type: 'error', message: 'boom' }));
    expect(buildTimeline(s.items).blocks.at(-1)).toEqual({ kind: 'error', message: 'boom' });
    expect(s.lastSeq).toBe(6);
  });
});

describe('run events loader', () => {
  it('batches loads made in the same tick and resolves unknown runs to []', async () => {
    const calls: string[][] = [];
    const loader = createRunEventsLoader(async (ids) => {
      calls.push(ids);
      return {
        runs: {
          r1: { status: 'succeeded', events: [{ seq: 1, event: { type: 'text.final', text: 'hi' } }] },
        },
      };
    });
    const [a, b, a2] = await Promise.all([loader.load('r1'), loader.load('r2'), loader.load('r1')]);
    expect(calls).toEqual([['r1', 'r2']]);
    expect(a).toHaveLength(1);
    expect(a2).toBe(a);
    expect(b).toEqual([]);
  });

  it('splits big batches and rejects every waiter of a failed request', async () => {
    const sizes: number[] = [];
    const loader = createRunEventsLoader(async (ids) => {
      sizes.push(ids.length);
      throw new Error('down');
    });
    const loads = Array.from({ length: 60 }, (_, i) => loader.load(`r${i}`));
    const results = await Promise.allSettled(loads);
    expect(sizes).toEqual([50, 10]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });
});

describe('last turn helpers', () => {
  it('finds the retryable turn per bot and the last user message', () => {
    const older = run('r1', { status: 'failed', botId: 'b1' });
    const newer = run('r2', { status: 'succeeded', botId: 'b1' });
    expect(retryableRun([older, newer], 'b1')?.id).toBe('r2');
    expect(retryableRun([older, run('r3', { status: 'running', botId: 'b1' })], 'b1')).toBeNull();
    expect(retryableRun([older], 'b2')).toBeNull();
    const msgs = [
      msg('u1'),
      msg('b', { authorType: 'bot', authorBotId: 'b1' }),
      msg('u2'),
      msg('c', { authorType: 'bot', authorBotId: 'b1' }),
    ];
    expect(lastUserMessage(msgs)?.id).toBe('u2');
    expect(lastUserMessage([])).toBeNull();
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

describe('@mention autocomplete', () => {
  const bots = [
    { slug: 'agent-a', name: 'Agent A' },
    { slug: 'alice', name: 'Alice' },
    { slug: 'code-reviewer', name: 'Code Reviewer' },
  ];
  it('finds the mention being typed before the caret', () => {
    expect(mentionAt('hi @al', 6)).toEqual({ start: 3, query: 'al' });
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionAt('mail x@al', 9)).toBeNull();
    expect(mentionAt('@alice done', 11)).toBeNull();
    expect(mentionAt('hi @al and more', 6)).toEqual({ start: 3, query: 'al' });
  });
  it('ranks prefix matches first and inserts @slug with one space', () => {
    expect(mentionCandidates(bots, 'a').map((b) => b.slug)).toEqual(['agent-a', 'alice']);
    expect(mentionCandidates(bots, 'rev').map((b) => b.slug)).toEqual(['code-reviewer']);
    expect(mentionCandidates(bots, '')).toHaveLength(3);
    expect(insertMention('hi @al', 6, 3, 'alice')).toEqual({ text: 'hi @alice ', caret: 10 });
    expect(insertMention('hi @al there', 6, 3, 'alice')).toEqual({ text: 'hi @alice there', caret: 10 });
  });
});

describe('workingBots', () => {
  it('lists each active bot once, working before queued', () => {
    expect(
      workingBots([
        { botId: 'a', status: 'queued' },
        { botId: 'b', status: 'succeeded' },
        { botId: 'c', status: 'running' },
        { botId: 'a', status: 'running' },
        { botId: 'd', status: 'queued' },
      ]),
    ).toEqual([
      { botId: 'a', state: 'working' },
      { botId: 'c', state: 'working' },
      { botId: 'd', state: 'queued' },
    ]);
  });
});
