'use client';

import { type BotView, containerPath } from '@agenta/shared';
import type RFB from '@novnc/novnc';
import { Camera, Eye, Maximize, Minimize, MousePointerClick, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useShell } from '@/components/shell/shell-context';
import { botsApi } from '@/lib/bots';
import { type DesktopStatus, describeDesktopStatus, desktopUrl } from '@/lib/desktop';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * The bot's live screen (Xvfb :99) via noVNC. View-only until the owner takes control; scaled to the panel;
 * full-screen on demand. Mounted only while the Desktop tab is shown, so a watched desktop keeps the computer
 * awake and an unwatched one does not.
 */
export function DesktopView({ bot }: { bot: BotView }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [status, setStatus] = useState<DesktopStatus>({ state: 'connecting' });
  const [control, setControl] = useState(false);
  const controlRef = useRef(control);
  controlRef.current = control;
  const [fullscreen, setFullscreen] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [shooting, setShooting] = useState(false);
  const { openFile } = useShell();
  const running = bot.status === 'running';
  const runningRef = useRef(running);
  runningRef.current = running;

  useEffect(() => {
    let disposed = false;
    let rfb: RFB | null = null;
    void (async () => {
      if (!runningRef.current) {
        setStatus({ state: 'starting' });
        try {
          await botsApi.startComputer(bot.id);
        } catch (err) {
          if (!disposed) setStatus({ state: 'error', detail: (err as Error).message });
          return;
        }
      }
      if (disposed) return;
      setStatus({ state: 'connecting' });
      // noVNC touches `window` at import time: client only.
      const { default: RFBClient } = await import('@novnc/novnc');
      if (disposed || !screenRef.current) return;
      rfb = new RFBClient(screenRef.current, desktopUrl(window.location, bot.id), { shared: true });
      rfb.viewOnly = !controlRef.current;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = '#0b0d12';
      rfb.addEventListener('connect', () => setStatus({ state: 'connected' }));
      rfb.addEventListener('disconnect', (ev) => {
        rfbRef.current = null;
        if (disposed) return;
        const clean = (ev as CustomEvent<{ clean: boolean }>).detail.clean;
        setStatus(clean ? { state: 'disconnected' } : { state: 'error' });
      });
      rfbRef.current = rfb;
    })();
    return () => {
      disposed = true;
      rfb?.disconnect();
      rfbRef.current = null;
    };
  }, [bot.id, generation]);

  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.viewOnly = !control;
    if (control) rfb.focus();
  }, [control]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void frameRef.current?.requestFullscreen();
  }

  async function screenshot() {
    setShooting(true);
    try {
      const shot = await botsApi.screenshot(bot.id);
      const path = containerPath(shot.root, shot.path);
      toast.success(`Screenshot saved to ~/${shot.path}`, {
        action: { label: 'Open', onClick: () => openFile(bot.id, path) },
      });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setShooting(false);
    }
  }

  const ended = status.state === 'disconnected' || status.state === 'error';
  return (
    <div ref={frameRef} className="flex min-h-0 flex-1 flex-col bg-panel">
      <div
        className="flex h-8 shrink-0 items-center gap-2 border-b px-2 text-xs text-muted-foreground"
        data-testid="desktop-status"
        data-state={status.state}
      >
        <span
          aria-hidden
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            status.state === 'connected' && 'bg-emerald-500',
            (status.state === 'connecting' || status.state === 'starting') && 'animate-pulse bg-amber-500',
            status.state === 'disconnected' && 'bg-muted-foreground',
            status.state === 'error' && 'bg-destructive',
          )}
        />
        <span className="truncate" role="status">
          {describeDesktopStatus(status)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {ended && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2"
              onClick={() => setGeneration((g) => g + 1)}
            >
              <RotateCcw className="size-3.5" aria-hidden />
              Reconnect
            </Button>
          )}
          <Button
            size="sm"
            variant={control ? 'secondary' : 'ghost'}
            className="h-6 px-2"
            aria-pressed={control}
            title={control ? 'Your mouse and keyboard go to the bot' : 'Watching only'}
            onClick={() => setControl((c) => !c)}
          >
            {control ? (
              <MousePointerClick className="size-3.5" aria-hidden />
            ) : (
              <Eye className="size-3.5" aria-hidden />
            )}
            {control ? 'In control' : 'Take control'}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-6"
            aria-label="Screenshot"
            title="Save a screenshot to the bot's files"
            disabled={status.state !== 'connected' || shooting}
            onClick={() => void screenshot()}
          >
            <Camera className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-6"
            aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
            onClick={toggleFullscreen}
          >
            {fullscreen ? <Minimize className="size-3.5" /> : <Maximize className="size-3.5" />}
          </Button>
        </div>
      </div>
      <div
        ref={screenRef}
        data-testid="desktop"
        className={cn('min-h-0 flex-1 bg-[#0b0d12]', control && 'ring-2 ring-inset ring-primary')}
      />
    </div>
  );
}
