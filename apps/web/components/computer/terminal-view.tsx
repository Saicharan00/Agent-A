'use client';

import '@xterm/xterm/css/xterm.css';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { describeStatus, TerminalConnection, type TerminalStatus, terminalUrl } from '@/lib/terminal';
import { cn } from '@/lib/utils';

// Terminals stay dark in both themes (what CLIs and their colour schemes expect).
const THEME = {
  background: '#0b0d12',
  foreground: '#d7dae0',
  cursor: '#d7dae0',
  selectionBackground: '#3b4252',
  black: '#1d2129',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#d7dae0',
  brightBlack: '#5c6370',
  brightRed: '#ef8189',
  brightGreen: '#a9d48a',
  brightYellow: '#f0cf8f',
  brightBlue: '#7cc0f7',
  brightMagenta: '#d68ff0',
  brightCyan: '#6ccad6',
  brightWhite: '#ffffff',
};

/**
 * One xterm.js terminal attached to a shell in the bot's computer. Hidden terminals keep their shell; they refit
 * when shown again. When the shell ends or the connection drops, "New shell" starts a fresh one in the same view.
 */
export function TerminalView({
  botId,
  visible,
  onStatus,
}: {
  botId: string;
  visible: boolean;
  onStatus?: (s: TerminalStatus) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connRef = useRef<TerminalConnection | null>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const [status, setStatus] = useState<TerminalStatus>({ state: 'connecting' });
  const [generation, setGeneration] = useState(0);

  const fit = useCallback(() => {
    const el = hostRef.current;
    // A hidden panel has no size; fitting then would shrink the shell to nothing.
    if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
    try {
      fitRef.current?.fit();
    } catch {
      // not rendered yet
    }
  }, []);

  // The xterm instance lives as long as the view (xterm touches `window`, so it loads on the client only).
  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    void (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
      ]);
      if (disposed || !hostRef.current) return;
      const term = new Terminal({
        theme: THEME,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 12,
        cursorBlink: true,
        scrollback: 5000,
        allowProposedApi: false,
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(
        new WebLinksAddon((_ev, uri) => {
          window.open(uri, '_blank', 'noopener,noreferrer');
        }),
      );
      term.open(hostRef.current);
      termRef.current = term;
      fitRef.current = fitAddon;
      fit();
      const data = term.onData((d) => connRef.current?.sendInput(d));
      const resize = term.onResize(({ cols, rows }) => connRef.current?.resize(cols, rows));
      const observer = new ResizeObserver(() => fit());
      observer.observe(hostRef.current);
      cleanups.push(
        () => data.dispose(),
        () => resize.dispose(),
        () => observer.disconnect(),
      );
      setGeneration((g) => g + 1); // xterm is ready: connect
    })();
    return () => {
      disposed = true;
      for (const c of cleanups) c();
      connRef.current?.close();
      connRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [fit]);

  // One connection (= one shell) per generation; "New shell" bumps it.
  useEffect(() => {
    const term = termRef.current;
    if (generation === 0 || !term) return;
    if (generation > 1) term.write('\r\n\x1b[2m--- new shell ---\x1b[0m\r\n');
    const conn = new TerminalConnection({
      url: terminalUrl(window.location, botId, { cols: term.cols, rows: term.rows }),
      onOutput: (d) => term.write(d),
      onStatus: (s) => {
        setStatus(s);
        onStatusRef.current?.(s);
        if (s.state === 'open') {
          // The panel may have been resized while the computer was starting.
          conn.resize(term.cols, term.rows);
        }
      },
    });
    connRef.current = conn;
    conn.connect();
    return () => {
      conn.close();
      if (connRef.current === conn) connRef.current = null;
    };
  }, [botId, generation]);

  useEffect(() => {
    if (!visible) return;
    fit();
    termRef.current?.focus();
  }, [visible, fit]);

  const ended = status.state === 'exited' || status.state === 'disconnected' || status.state === 'error';
  return (
    <div className={cn('relative flex min-h-0 flex-1 flex-col', !visible && 'hidden')}>
      <div
        className="flex h-7 shrink-0 items-center gap-2 border-b px-2 text-xs text-muted-foreground"
        data-testid="terminal-status"
        data-state={status.state}
      >
        <span
          aria-hidden
          className={cn(
            'size-1.5 rounded-full',
            status.state === 'open' && 'bg-emerald-500',
            (status.state === 'connecting' || status.state === 'starting') && 'animate-pulse bg-amber-500',
            ended && 'bg-muted-foreground',
            status.state === 'error' && 'bg-destructive',
          )}
        />
        <span className="truncate" role="status">
          {describeStatus(status)}
        </span>
        {ended && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-6 px-2"
            onClick={() => setGeneration((g) => g + 1)}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            New shell
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 bg-[#0b0d12] p-1.5">
        <div ref={hostRef} className="size-full" data-testid="terminal" />
      </div>
    </div>
  );
}
