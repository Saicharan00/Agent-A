'use client';

import {
  AlertTriangle,
  Bot,
  ChevronRight,
  FileEdit,
  FilePlus,
  FileSearch,
  FileText,
  Globe,
  type LucideIcon,
  MonitorPlay,
  Plug,
  Search,
  SquareTerminal,
  Wrench,
} from 'lucide-react';
import { memo, useState } from 'react';
import type { ToolBlock } from '@/lib/timeline';
import { type DiffLine, type ToolView, describeTool, stripAnsi, truncateOutput } from '@/lib/tools';
import { cn } from '@/lib/utils';

const ICONS: Record<ToolView['kind'], LucideIcon> = {
  command: SquareTerminal,
  read: FileText,
  write: FilePlus,
  edit: FileEdit,
  patch: FileEdit,
  search: FileSearch,
  web: Search,
  browser: MonitorPlay,
  platform: Bot,
  mcp: Plug,
  other: Wrench,
};

/** Long output, cut to a few lines with "Show more". */
function Output({ text, isError }: { text: string; isError: boolean }) {
  const [all, setAll] = useState(false);
  const clean = stripAnsi(text).replace(/\s+$/, '');
  const { text: short, cut } = truncateOutput(clean);
  if (!clean) return <p className="text-xs text-muted-foreground italic">No output.</p>;
  return (
    <div className="space-y-1">
      <pre
        className={cn(
          'max-h-[28rem] overflow-auto rounded bg-muted/70 p-2 font-mono text-xs whitespace-pre-wrap',
          isError && 'text-destructive',
        )}
        data-testid="tool-output"
      >
        {all ? clean : short}
      </pre>
      {cut && (
        <button
          type="button"
          className="text-xs text-primary hover:underline"
          onClick={() => setAll((v) => !v)}
        >
          {all ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

const DIFF_PREVIEW = 40;

function Diff({ lines }: { lines: DiffLine[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, DIFF_PREVIEW);
  return (
    <div className="space-y-1">
      <pre
        className="max-h-[28rem] overflow-auto rounded bg-muted/70 py-1 font-mono text-xs"
        data-testid="tool-diff"
      >
        {shown.map((l, i) => (
          <div
            key={i}
            className={cn(
              'px-2 whitespace-pre-wrap',
              l.op === '+' && 'bg-success/15 text-success',
              l.op === '-' && 'bg-destructive/15 text-destructive',
            )}
          >
            <span aria-hidden className="mr-2 opacity-60 select-none">
              {l.op}
            </span>
            {l.text}
          </div>
        ))}
      </pre>
      {lines.length > DIFF_PREVIEW && (
        <button
          type="button"
          className="text-xs text-primary hover:underline"
          onClick={() => setAll((v) => !v)}
        >
          {all ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

/** One tool call: a collapsible card with what was called and what came back. */
export const ToolCard = memo(function ToolCard({ block, running }: { block: ToolBlock; running: boolean }) {
  const view = describeTool(block.name, block.input);
  const Icon = ICONS[view.kind];
  const pending = !block.result && running;
  const failed = block.result?.isError ?? false;
  return (
    <details
      className="group/tool rounded-md border bg-card text-sm"
      data-testid="tool-card"
      data-tool={block.name}
      data-kind={view.kind}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 select-none [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/tool:rotate-90"
          aria-hidden
        />
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="shrink-0 font-medium">{view.label}</span>
        {view.detail && (
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={view.detail}>
            {view.detail}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-xs">
          {pending && <span className="text-muted-foreground">running…</span>}
          {failed && (
            <span className="inline-flex items-center gap-1 text-destructive">
              <AlertTriangle className="size-3.5" aria-hidden />
              error
            </span>
          )}
        </span>
      </summary>
      <div className="space-y-2 border-t px-3 py-2">
        {view.command && (
          <pre className="overflow-x-auto rounded bg-muted/70 p-2 font-mono text-xs whitespace-pre-wrap">
            <span className="text-muted-foreground select-none">$ </span>
            {view.command}
          </pre>
        )}
        {view.path && !view.detail?.includes(view.path) && (
          <p className="font-mono text-xs text-muted-foreground">{view.path}</p>
        )}
        {view.paths && view.paths.length > 0 && (
          <ul className="font-mono text-xs text-muted-foreground">
            {view.paths.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {view.diff && view.diff.length > 0 && <Diff lines={view.diff} />}
        {view.json && (
          <pre className="max-h-60 overflow-auto rounded bg-muted/70 p-2 font-mono text-xs">{view.json}</pre>
        )}
        {view.kind === 'web' && !view.json && view.detail && (
          <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Globe className="size-3.5" aria-hidden />
            {view.detail}
          </p>
        )}
        {block.result ? (
          <Output text={block.result.output} isError={failed} />
        ) : (
          !running && <p className="text-xs text-muted-foreground italic">No result recorded.</p>
        )}
      </div>
    </details>
  );
});
