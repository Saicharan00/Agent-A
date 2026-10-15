'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Hammer } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { queryKeys } from '@/lib/query-keys';
import { systemApi } from '@/lib/system';
import { toast } from '@/lib/toast';

/** "Build image" button with the live build log (F31). Polls the runner while a build runs. */
export function ImageBuild({ label = 'Build image' }: { label?: string }) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: queryKeys.imageBuild,
    queryFn: systemApi.imageBuild,
    refetchInterval: (q) => (q.state.data?.state === 'running' ? 1000 : false),
  });
  const start = useMutation({
    mutationFn: systemApi.startImageBuild,
    onSuccess: (s) => qc.setQueryData(queryKeys.imageBuild, s),
    onError: (err) => toast.error(`Could not start the build: ${err.message}`),
  });
  const state = status.data?.state;
  const prev = useRef(state);
  useEffect(() => {
    // A build just finished: refresh the checks and the Docker pill.
    if (prev.current === 'running' && state && state !== 'running') {
      void qc.invalidateQueries({ queryKey: queryKeys.doctor });
      void qc.invalidateQueries({ queryKey: queryKeys.runnerStatus });
      if (state === 'succeeded') toast.success('Bot image built');
      else toast.error('Image build failed: see the log');
    }
    prev.current = state;
  }, [state, qc]);

  const log = status.data?.log ?? [];
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log.length]);

  return (
    <div className="space-y-2" data-testid="image-build">
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={() => start.mutate()} disabled={state === 'running' || start.isPending}>
          <Hammer />
          {state === 'running' ? 'Building…' : label}
        </Button>
        {state === 'running' && (
          <span className="text-sm text-muted-foreground">This takes several minutes the first time.</span>
        )}
        {state === 'succeeded' && (
          <span className="text-sm text-muted-foreground">Last build succeeded.</span>
        )}
        {state === 'failed' && (
          <span className="text-sm text-destructive">
            Last build failed (exit {status.data?.exitCode ?? '?'}).
          </span>
        )}
      </div>
      {log.length > 0 && (
        <pre
          ref={logRef}
          aria-label="Image build log"
          className="max-h-64 overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed"
        >
          {log.join('\n')}
        </pre>
      )}
    </div>
  );
}
