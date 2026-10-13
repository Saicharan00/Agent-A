// How tool calls read in the chat (F13): a friendly label and the bits worth showing for each engine's tools
// (Claude Code: Bash/Read/Write/Edit/…; Codex: shell/apply_patch/web_search; MCP: mcp__<server>__<tool>).

export type DiffLine = { op: ' ' | '+' | '-'; text: string };

export type ToolView = {
  kind:
    | 'command'
    | 'read'
    | 'write'
    | 'edit'
    | 'patch'
    | 'search'
    | 'web'
    | 'browser'
    | 'platform'
    | 'mcp'
    | 'other';
  label: string;
  /** One-line summary next to the label (command, path, query, url…). */
  detail?: string;
  command?: string;
  path?: string;
  diff?: DiffLine[];
  /** Changed files of a Codex patch. */
  paths?: string[];
  /** Pretty input for tools without a dedicated view. */
  json?: string;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Labels for the platform's own MCP tools (F17), as an owner would say them. */
const PLATFORM_LABELS: Record<string, string> = {
  create_task: 'Created a task',
  update_task: 'Updated a task',
  list_tasks: 'Checked the task board',
  get_task: 'Read a task',
  complete_task: 'Completed a task',
  message_bot: 'Messaged a teammate',
  post_message: 'Posted in a thread',
  record_decision: 'Recorded a decision',
  record_lesson: 'Recorded a lesson',
  request_approval: 'Asked for approval',
  remember: 'Saved a memory',
  save_memory: 'Saved a memory',
  search_memory: 'Searched memories',
  list_bots: 'Looked up the team',
};

const BROWSER_LABELS: Record<string, string> = {
  navigate: 'Opened a page',
  navigate_back: 'Went back',
  click: 'Clicked',
  type: 'Typed',
  fill_form: 'Filled a form',
  press_key: 'Pressed a key',
  snapshot: 'Read the page',
  take_screenshot: 'Took a screenshot',
  wait_for: 'Waited',
  select_option: 'Picked an option',
  hover: 'Hovered',
  tabs: 'Switched tabs',
  close: 'Closed the browser',
};

const humanize = (s: string) => s.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const firstLine = (s: string) => s.split('\n')[0]!.slice(0, 160);

function pretty(input: unknown): string | undefined {
  if (input === undefined || (isObj(input) && Object.keys(input).length === 0)) return undefined;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export function describeTool(name: string, input: unknown): ToolView {
  const i = isObj(input) ? input : {};
  const path = str(i.file_path) ?? str(i.path) ?? str(i.notebook_path);

  if (name.startsWith('mcp__')) {
    const [, server = '', ...rest] = name.split('__');
    const tool = rest.join('__');
    if (server === 'agenta') {
      return { kind: 'platform', label: PLATFORM_LABELS[tool] ?? humanize(tool), json: pretty(input) };
    }
    if (server === 'playwright' || tool.startsWith('browser_')) {
      const action = tool.replace(/^browser_/, '');
      const url = str(i.url);
      return {
        kind: 'browser',
        label: BROWSER_LABELS[action] ?? `Browser: ${humanize(action)}`,
        detail: url ?? str(i.element) ?? str(i.text),
        json: pretty(input),
      };
    }
    return { kind: 'mcp', label: `${server}: ${humanize(tool)}`, json: pretty(input) };
  }

  switch (name) {
    case 'Bash':
    case 'shell': {
      const raw = i.command;
      const command = Array.isArray(raw) ? raw.map(String).join(' ') : (str(raw) ?? '');
      return { kind: 'command', label: 'Ran a command', detail: firstLine(command), command };
    }
    case 'Read':
      return { kind: 'read', label: 'Read a file', detail: path, path };
    case 'Write': {
      const content = str(i.content) ?? '';
      return {
        kind: 'write',
        label: 'Wrote a file',
        detail: path,
        path,
        diff: content ? lineDiff('', content) : undefined,
      };
    }
    case 'Edit':
      return {
        kind: 'edit',
        label: 'Edited a file',
        detail: path,
        path,
        diff: lineDiff(str(i.old_string) ?? '', str(i.new_string) ?? ''),
      };
    case 'MultiEdit': {
      const edits = Array.isArray(i.edits) ? i.edits.filter(isObj) : [];
      const diff = edits.flatMap((e, n) => [
        ...(n > 0 ? [{ op: ' ' as const, text: '⋯' }] : []),
        ...lineDiff(str(e.old_string) ?? '', str(e.new_string) ?? ''),
      ]);
      return { kind: 'edit', label: `Edited a file (${edits.length} changes)`, detail: path, path, diff };
    }
    case 'apply_patch': {
      const changes = Array.isArray(i.changes) ? i.changes.filter(isObj) : [];
      const paths = changes.map((c) => `${str(c.path) ?? '?'}${str(c.kind) ? ` (${str(c.kind)})` : ''}`);
      const patch = str(i.patch) ?? str(i.input);
      return {
        kind: 'patch',
        label: paths.length === 1 ? 'Changed a file' : `Changed ${paths.length || 'some'} files`,
        detail: paths[0],
        paths,
        diff: patch ? patchLines(patch) : undefined,
      };
    }
    case 'Glob':
    case 'Grep':
    case 'LS':
      return {
        kind: 'search',
        label: name === 'LS' ? 'Listed a folder' : 'Searched files',
        detail: str(i.pattern) ?? path,
        json: pretty(input),
      };
    case 'WebFetch':
      return { kind: 'web', label: 'Fetched a web page', detail: str(i.url), json: pretty(input) };
    case 'WebSearch':
    case 'web_search':
      return { kind: 'web', label: 'Searched the web', detail: str(i.query) };
    case 'TodoWrite':
      return { kind: 'other', label: 'Updated the to-do list', json: pretty(input) };
    case 'Task':
      return { kind: 'other', label: 'Started a sub-agent', detail: str(i.description), json: pretty(input) };
    default:
      return { kind: 'other', label: humanize(name), json: pretty(input) };
  }
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
// CSI (colours, cursor moves) and OSC (titles, links) sequences.
const ANSI = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`,
  'g',
);

/** Terminal output without colour codes; carriage-return progress lines keep only their final state. */
export function stripAnsi(s: string): string {
  return s
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r', line.length - 2) + 1).replace(/\r$/, ''))
    .join('\n');
}

/** The first `maxLines` lines / `maxChars` characters, and whether anything was cut. */
export function truncateOutput(s: string, maxLines = 16, maxChars = 2000): { text: string; cut: boolean } {
  const lines = s.split('\n');
  let text = lines.slice(0, maxLines).join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return { text, cut: text.length < s.length };
}

const MAX_DIFF_LINES = 400;

/** A line diff (LCS). Large inputs fall back to "all removed, all added". */
export function lineDiff(before: string, after: string): DiffLine[] {
  // A final newline ends the last line; it doesn't start an empty one.
  const lines = (t: string) => (t ? t.replace(/\n$/, '').split('\n') : []);
  const a = lines(before);
  const b = lines(after);
  if (a.length * b.length > MAX_DIFF_LINES * MAX_DIFF_LINES) {
    return [
      ...a.map((text) => ({ op: '-' as const, text })),
      ...b.map((text) => ({ op: '+' as const, text })),
    ];
  }
  // lcs[i][j] = LCS length of a[i:], b[j:]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: '-', text: a[i++]! });
    else out.push({ op: '+', text: b[j++]! });
  }
  while (i < a.length) out.push({ op: '-', text: a[i++]! });
  while (j < b.length) out.push({ op: '+', text: b[j++]! });
  return out;
}

/** A unified patch as coloured lines (headers shown as context). */
export function patchLines(patch: string): DiffLine[] {
  return patch.split('\n').map((line) => {
    if (line.startsWith('+') && !line.startsWith('+++')) return { op: '+', text: line.slice(1) };
    if (line.startsWith('-') && !line.startsWith('---')) return { op: '-', text: line.slice(1) };
    return { op: ' ', text: line };
  });
}

/** "850 ms", "12 s", "3 min 05 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/** "1.2k" style token counts. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
