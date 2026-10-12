import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { JsonlParser, parseJsonl } from '../../src/engines/jsonl';

describe('JsonlParser', () => {
  it('parses whole lines and keeps partial ones until completed', () => {
    const p = new JsonlParser();
    expect(p.push('{"a":1}\n{"b":')).toEqual([{ a: 1 }]);
    expect(p.push('2}\n')).toEqual([{ b: 2 }]);
    expect(p.push('{"c":3}')).toEqual([]);
    expect(p.end()).toEqual([{ c: 3 }]);
  });

  it('handles CRLF, blank lines and many lines in one chunk', () => {
    const p = new JsonlParser();
    expect(p.push('{"a":1}\r\n\n  \r\n[1,2]\n"s"\n')).toEqual([{ a: 1 }, [1, 2], 's']);
  });

  it('reports non-JSON noise instead of throwing', () => {
    const noise: string[] = [];
    const p = new JsonlParser({ onNoise: (l) => noise.push(l) });
    expect(p.push('[agenta-entrypoint] desktop starting\n{"ok":true}\nnot json {\n')).toEqual([{ ok: true }]);
    expect(noise).toEqual(['[agenta-entrypoint] desktop starting', 'not json {']);
  });

  it('decodes UTF-8 characters split across chunks', () => {
    const p = new JsonlParser();
    const bytes = Buffer.from('{"t":"héllo 👋"}\n');
    const cut = bytes.indexOf(0xf0) + 2; // inside the emoji
    expect(p.push(bytes.subarray(0, 8))).toEqual([]);
    expect(p.push(bytes.subarray(8, cut))).toEqual([]);
    expect(p.push(bytes.subarray(cut))).toEqual([{ t: 'héllo 👋' }]);
  });

  it('drops oversized lines (also across chunks) and recovers on the next line', () => {
    const sizes: number[] = [];
    const p = new JsonlParser({ maxLineLength: 10, onOversized: (n) => sizes.push(n) });
    expect(p.push('{"x":"aaaaaaaaaaaaaaaa"}\n{"y":1}\n')).toEqual([{ y: 1 }]);
    expect(p.push('{"z":"bbbbbb')).toEqual([]);
    expect(p.push('bbbbbbbbbbbb')).toEqual([]);
    expect(p.push('"}\n{"w":2}\n')).toEqual([{ w: 2 }]);
    expect(sizes).toEqual([24, 26]);
    expect(p.end()).toEqual([]);
  });

  it('drops an unterminated oversized tail at end()', () => {
    const sizes: number[] = [];
    const p = new JsonlParser({ maxLineLength: 5, onOversized: (n) => sizes.push(n) });
    p.push('{"long":true');
    expect(p.end()).toEqual([]);
    expect(sizes).toEqual([12]);
  });

  it('parseJsonl reads a stream', async () => {
    const src = Readable.from([Buffer.from('{"a":1}\n{"b"'), Buffer.from(':2}\nnoise\n{"c":3}')]);
    const noise: string[] = [];
    const out: unknown[] = [];
    for await (const v of parseJsonl(src, { onNoise: (l) => noise.push(l) })) out.push(v);
    expect(out).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(noise).toEqual(['noise']);
  });
});
