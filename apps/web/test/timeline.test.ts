import type { EngineEvent, RunEventItem } from '@agenta/shared';
import { describe, expect, it } from 'vitest';
import { appendEventItem, buildTimeline, timelineText } from '@/lib/timeline';
import {
  describeTool,
  formatDuration,
  formatTokens,
  lineDiff,
  patchLines,
  stripAnsi,
  truncateOutput,
} from '@/lib/tools';

const items = (events: EngineEvent[]): RunEventItem[] => events.map((event, i) => ({ seq: i + 1, event }));

describe('buildTimeline', () => {
  it('interleaves streamed text with tool calls and keeps that layout when the final text matches', () => {
    const t = buildTimeline(
      items([
        { type: 'run.started', engine: 'mock' },
        { type: 'thinking', text: 'plan' },
        { type: 'text.delta', text: 'Let me check. ' },
        { type: 'tool.call', callId: 'c1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool.result', callId: 'c1', output: 'a.txt' },
        { type: 'file.changed', path: '/home/bot/work/a.txt', change: 'created' },
        { type: 'text.delta', text: 'Done.' },
        { type: 'text.final', text: 'Let me check. Done.' },
        { type: 'usage', inputTokens: 1 },
        { type: 'run.finished', status: 'succeeded' },
      ]),
    );
    expect(t.blocks.map((b) => b.kind)).toEqual(['thinking', 'text', 'tool', 'text']);
    expect(t.blocks[2]).toMatchObject({ name: 'Bash', result: { output: 'a.txt', isError: false } });
    expect(t.files).toEqual([{ path: '/home/bot/work/a.txt', change: 'created' }]);
    expect(t.finished).toBe(true);
    expect(timelineText(t)).toBe('Let me check.\n\nDone.');
  });

  it('replaces a streamed draft that differs from the final text, and adds finals that were never streamed', () => {
    const t = buildTimeline(
      items([
        { type: 'text.delta', text: 'Draft wi' },
        { type: 'text.final', text: 'Final words' },
        { type: 'tool.call', callId: 'c', name: 'Read', input: {} },
        { type: 'text.final', text: 'Second message' },
      ]),
    );
    expect(t.blocks).toEqual([
      { kind: 'text', text: 'Final words' },
      expect.objectContaining({ kind: 'tool' }),
      { kind: 'text', text: 'Second message' },
    ]);
  });

  it('keeps partial text of a stopped run, errors, notes, orphan results and the latest change per file', () => {
    const t = buildTimeline(
      items([
        { type: 'text.delta', text: 'Working' },
        { type: 'system', message: 'retrying' },
        { type: 'tool.result', callId: 'x', output: 'late', isError: true },
        { type: 'file.changed', path: 'a', change: 'created' },
        { type: 'file.changed', path: 'b', change: 'modified' },
        { type: 'file.changed', path: 'a', change: 'deleted' },
        { type: 'error', message: 'boom' },
        { type: 'run.finished', status: 'cancelled' },
      ]),
    );
    expect(t.blocks).toEqual([
      { kind: 'text', text: 'Working' },
      { kind: 'system', message: 'retrying' },
      { kind: 'tool', callId: 'x', name: 'tool', input: {}, result: { output: 'late', isError: true } },
      { kind: 'error', message: 'boom' },
    ]);
    expect(t.files.map((f) => `${f.path}:${f.change}`)).toEqual(['b:modified', 'a:deleted']);
  });

  it('appendEventItem merges deltas and drops repeats', () => {
    let list: RunEventItem[] = [];
    list = appendEventItem(list, { seq: 1, event: { type: 'text.delta', text: 'a' } });
    list = appendEventItem(list, { seq: 2, event: { type: 'text.delta', text: 'b' } });
    list = appendEventItem(list, { seq: 2, event: { type: 'text.delta', text: 'b' } });
    list = appendEventItem(list, { seq: 3, event: { type: 'text.final', text: 'ab' } });
    expect(list).toEqual([
      { seq: 2, event: { type: 'text.delta', text: 'ab' } },
      { seq: 3, event: { type: 'text.final', text: 'ab' } },
    ]);
  });
});

describe('describeTool', () => {
  it('labels Claude Code, Codex and MCP tools', () => {
    expect(describeTool('Bash', { command: 'npm test\nmore' })).toMatchObject({
      kind: 'command',
      label: 'Ran a command',
      detail: 'npm test',
      command: 'npm test\nmore',
    });
    expect(describeTool('shell', { command: ['bash', '-lc', 'ls'] })).toMatchObject({
      command: 'bash -lc ls',
    });
    expect(
      describeTool('Edit', { file_path: '/a.ts', old_string: 'x\ny', new_string: 'x\nz' }),
    ).toMatchObject({
      kind: 'edit',
      path: '/a.ts',
      diff: [
        { op: ' ', text: 'x' },
        { op: '-', text: 'y' },
        { op: '+', text: 'z' },
      ],
    });
    expect(describeTool('Write', { file_path: '/b', content: 'hi\n' }).diff).toEqual([
      { op: '+', text: 'hi' },
    ]);
    expect(
      describeTool('apply_patch', {
        changes: [
          { path: 'a', kind: 'add' },
          { path: 'b', kind: 'update' },
        ],
      }),
    ).toMatchObject({ kind: 'patch', label: 'Changed 2 files', paths: ['a (add)', 'b (update)'] });
    expect(describeTool('web_search', { query: 'q' })).toMatchObject({
      kind: 'web',
      label: 'Searched the web',
    });
    expect(describeTool('mcp__agenta__create_task', { title: 't' })).toMatchObject({
      kind: 'platform',
      label: 'Created a task',
    });
    expect(describeTool('mcp__agenta__brand_new_tool', {})).toMatchObject({ label: 'Brand new tool' });
    expect(describeTool('mcp__playwright__browser_navigate', { url: 'https://x.dev' })).toMatchObject({
      kind: 'browser',
      label: 'Opened a page',
      detail: 'https://x.dev',
    });
    expect(describeTool('mcp__github__create_issue', {})).toMatchObject({
      kind: 'mcp',
      label: 'github: Create issue',
    });
    expect(describeTool('Mystery', { a: 1 })).toMatchObject({ kind: 'other', json: '{\n  "a": 1\n}' });
  });
});

describe('output helpers', () => {
  it('strips colours and carriage-return progress', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m ok')).toBe('red ok');
    expect(stripAnsi('10%\r50%\r100%\nnext')).toBe('100%\nnext');
    expect(stripAnsi('\u001b]0;title\u0007text')).toBe('text');
  });

  it('truncates long output', () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const out = truncateOutput(long);
    expect(out.cut).toBe(true);
    expect(out.text.split('\n')).toHaveLength(16);
    expect(truncateOutput('short')).toEqual({ text: 'short', cut: false });
  });

  it('diffs lines and reads patches', () => {
    expect(lineDiff('a\nb\nc', 'a\nc\nd').map((l) => l.op + l.text)).toEqual([' a', '-b', ' c', '+d']);
    expect(patchLines('--- a\n+++ b\n-old\n+new\n ctx').map((l) => l.op)).toEqual([' ', ' ', '-', '+', ' ']);
  });

  it('formats durations and token counts', () => {
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(12_400)).toBe('12 s');
    expect(formatDuration(185_000)).toBe('3 min 05 s');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(45_000)).toBe('45k');
  });
});
