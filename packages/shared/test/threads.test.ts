import { describe, expect, it } from 'vitest';
import {
  composeUserMessage,
  composeUserPrompt,
  inboxFileNameSchema,
  sanitizeInboxName,
  sendMessageRequestSchema,
} from '../src/threads';

describe('inbox names', () => {
  it('keeps only a safe last path segment', () => {
    expect(sanitizeInboxName('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
    expect(sanitizeInboxName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeInboxName('.env')).toBe('env');
    expect(sanitizeInboxName('a\u0000b\nc.txt')).toBe('abc.txt');
    expect(sanitizeInboxName('...')).toBe('file');
    const long = `${'x'.repeat(200)}.tar.gz`;
    const out = sanitizeInboxName(long);
    expect(out).toHaveLength(120);
    expect(out.endsWith('.gz')).toBe(true);
  });

  it('accepts only plain names in requests', () => {
    expect(inboxFileNameSchema.safeParse('notes.txt').success).toBe(true);
    for (const bad of ['../x', 'a/b', 'a\\b', '.hidden', 'a\nb', '']) {
      expect(inboxFileNameSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('composing a user turn', () => {
  it('lists attachments in the stored message and as container paths in the prompt', () => {
    expect(composeUserMessage(' hi ', [])).toBe('hi');
    expect(composeUserMessage('', ['a.txt'])).toBe('📎 `inbox/a.txt`');
    expect(composeUserPrompt('Read it', ['a.txt'])).toBe(
      'Read it\n\nThe user attached a file:\n- /home/bot/work/inbox/a.txt',
    );
  });

  it('needs text or an attachment', () => {
    expect(sendMessageRequestSchema.safeParse({ content: ' ' }).success).toBe(false);
    expect(sendMessageRequestSchema.safeParse({ attachments: ['a.txt'] }).success).toBe(true);
  });
});

describe('session 2 helpers', () => {
  it('splits a stored user message back into text and attachments', async () => {
    const { splitUserMessage, composeUserMessage } = await import('../src/threads');
    expect(splitUserMessage(composeUserMessage('Read these', ['a.txt', 'b c.md']))).toEqual({
      content: 'Read these',
      attachments: ['a.txt', 'b c.md'],
    });
    expect(splitUserMessage(composeUserMessage('', ['a.txt']))).toEqual({
      content: '',
      attachments: ['a.txt'],
    });
    expect(splitUserMessage('just text 📎 not a list')).toEqual({
      content: 'just text 📎 not a list',
      attachments: [],
    });
  });

  it('compacts stored timelines', async () => {
    const { compactRunEvents, MAX_TOOL_OUTPUT_CHARS } = await import('../src/threads');
    const out = compactRunEvents([
      { seq: 1, event: { type: 'text.delta', text: 'a' } },
      { seq: 2, event: { type: 'text.delta', text: 'b' } },
      { seq: 3, event: { type: 'tool.result', callId: 'c', output: 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 10) } },
      { seq: 4, event: { type: 'text.delta', text: 'c' } },
    ]);
    expect(out.map((i) => i.seq)).toEqual([2, 3, 4]);
    expect(out[0]!.event).toEqual({ type: 'text.delta', text: 'ab' });
    const result = out[1]!.event as { output: string };
    expect(result.output).toContain('(10 more characters not shown)');
  });
});
