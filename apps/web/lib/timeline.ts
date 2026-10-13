// A bot turn's timeline (F13): the run's engine events folded into what the chat shows — text, thinking, tool calls
// with their results, errors and notes in order, plus the files it changed. Pure, so it is unit-tested.
import type { EngineEvent, FILE_CHANGES, RunEventItem } from '@agenta/shared';

export type ToolBlock = {
  kind: 'tool';
  callId: string;
  name: string;
  input: unknown;
  result?: { output: string; isError: boolean };
};
export type TimelineBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | ToolBlock
  | { kind: 'error'; message: string }
  | { kind: 'system'; message: string };

export type FileChange = { path: string; change: (typeof FILE_CHANGES)[number] };

export type Timeline = { blocks: TimelineBlock[]; files: FileChange[]; finished: boolean };

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

export function buildTimeline(items: RunEventItem[]): Timeline {
  const blocks: TimelineBlock[] = [];
  const files = new Map<string, FileChange>();
  const tools = new Map<string, ToolBlock>();
  /** Text blocks streamed (deltas) since the last text.final. */
  let open: { kind: 'text'; text: string }[] = [];
  let finished = false;

  for (const { event: e } of items) {
    const last = blocks[blocks.length - 1];
    switch (e.type) {
      case 'text.delta':
        if (last?.kind === 'text' && open.includes(last)) last.text += e.text;
        else {
          const b = { kind: 'text' as const, text: e.text };
          blocks.push(b);
          open.push(b);
        }
        break;
      case 'text.final': {
        const text = e.text.trim();
        // The final message usually equals what was streamed (possibly around tool calls): keep that layout.
        // Otherwise the final text replaces the streamed draft where it started.
        if (open.length > 0 && squash(open.map((b) => b.text).join('')) !== squash(text)) {
          const [first, ...rest] = open;
          first!.text = text;
          for (const b of rest) blocks.splice(blocks.indexOf(b), 1);
        } else if (open.length === 0 && text) {
          blocks.push({ kind: 'text', text });
        }
        open = [];
        break;
      }
      case 'thinking':
        if (last?.kind === 'thinking') last.text += `\n\n${e.text}`;
        else blocks.push({ kind: 'thinking', text: e.text });
        break;
      case 'tool.call': {
        const b: ToolBlock = { kind: 'tool', callId: e.callId, name: e.name, input: e.input };
        tools.set(e.callId, b);
        blocks.push(b);
        break;
      }
      case 'tool.result': {
        const result = { output: e.output, isError: e.isError ?? false };
        const b = tools.get(e.callId);
        if (b) b.result = result;
        else blocks.push({ kind: 'tool', callId: e.callId, name: 'tool', input: {}, result });
        break;
      }
      case 'file.changed':
        files.delete(e.path); // last change wins, in order of the latest change
        files.set(e.path, { path: e.path, change: e.change });
        break;
      case 'error':
        blocks.push({ kind: 'error', message: e.message });
        break;
      case 'system':
        blocks.push({ kind: 'system', message: e.message });
        break;
      case 'run.finished':
        finished = true;
        break;
      default:
        break;
    }
  }
  // Whitespace-only drafts (e.g. a lone newline delta) are noise.
  return {
    blocks: blocks.filter((b) => b.kind !== 'text' || b.text.trim()),
    files: [...files.values()],
    finished,
  };
}

/** The turn's text as one string (copying a reply that was never stored, e.g. a stopped run). */
export function timelineText(t: Timeline): string {
  return t.blocks
    .flatMap((b) => (b.kind === 'text' ? [b.text.trim()] : []))
    .filter(Boolean)
    .join('\n\n');
}

/** Appends a live event, merging consecutive deltas so long streams stay small. Repeats are ignored. */
export function appendEventItem(items: RunEventItem[], item: RunEventItem): RunEventItem[] {
  const prev = items[items.length - 1];
  if (prev && item.seq <= prev.seq) return items;
  const e: EngineEvent = item.event;
  if (e.type === 'text.delta' && prev?.event.type === 'text.delta') {
    return [
      ...items.slice(0, -1),
      { seq: item.seq, event: { type: 'text.delta', text: prev.event.text + e.text } },
    ];
  }
  return [...items, item];
}
