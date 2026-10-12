import { StringDecoder } from 'node:string_decoder';

// Line-buffered JSONL parsing for engine CLI output (claude/codex stream one JSON object per line).

export type JsonlOptions = {
  /** Lines longer than this (in UTF-16 code units) are dropped. Default 8 MiB. */
  maxLineLength?: number;
  /** Non-JSON lines (banners, warnings). Log at debug level; never at info (may contain prompt text). */
  onNoise?: (line: string) => void;
  /** Called once per dropped oversized line with its length so far. */
  onOversized?: (length: number) => void;
};

const DEFAULT_MAX_LINE = 8 * 1024 * 1024;

export class JsonlParser {
  private readonly decoder = new StringDecoder('utf8');
  private readonly max: number;
  private buf = '';
  /** True while skipping the rest of an oversized line. */
  private skipping = false;
  private skipped = 0;

  constructor(private readonly opts: JsonlOptions = {}) {
    this.max = opts.maxLineLength ?? DEFAULT_MAX_LINE;
  }

  /** Feeds a chunk; returns the JSON values of every line it completed. Partial lines are kept. */
  push(chunk: Buffer | string): unknown[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const out: unknown[] = [];
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      if (nl < 0) break;
      this.take(text.slice(start, nl), true, out);
      start = nl + 1;
    }
    this.take(text.slice(start), false, out);
    return out;
  }

  /** Flushes a final line without a trailing newline. */
  end(): unknown[] {
    const out: unknown[] = [];
    this.take(this.decoder.end(), false, out);
    if (this.skipping) this.opts.onOversized?.(this.skipped);
    else if (this.buf.length > 0) this.emit(this.buf, out);
    this.reset();
    return out;
  }

  private take(piece: string, complete: boolean, out: unknown[]): void {
    if (this.skipping) {
      this.skipped += piece.length;
      if (complete) {
        this.opts.onOversized?.(this.skipped);
        this.reset();
      }
      return;
    }
    this.buf += piece;
    if (this.buf.length > this.max) {
      this.skipping = true;
      this.skipped = this.buf.length;
      this.buf = '';
      if (complete) {
        this.opts.onOversized?.(this.skipped);
        this.reset();
      }
      return;
    }
    if (complete) {
      const line = this.buf;
      this.buf = '';
      this.emit(line, out);
    }
  }

  private emit(raw: string, out: unknown[]): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') return;
    try {
      out.push(JSON.parse(line));
    } catch {
      this.opts.onNoise?.(line);
    }
  }

  private reset(): void {
    this.buf = '';
    this.skipping = false;
    this.skipped = 0;
  }
}

/** Parses a byte/string stream (e.g. a CLI's stdout) into JSON values. */
export async function* parseJsonl(
  source: AsyncIterable<Buffer | string>,
  opts: JsonlOptions = {},
): AsyncGenerator<unknown> {
  const parser = new JsonlParser(opts);
  for await (const chunk of source) yield* parser.push(chunk);
  yield* parser.end();
}
