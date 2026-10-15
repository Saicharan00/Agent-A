'use client';

import { DAILY_BACKUPS_KEPT, FACTORY_RESET_WORD } from '@agenta/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/form';
import { formatBytes } from '@/lib/files';
import { queryKeys } from '@/lib/query-keys';
import { systemApi } from '@/lib/system';
import { toast } from '@/lib/toast';

const REASON_LABEL = {
  manual: 'manual',
  daily: 'daily',
  reset: 'before reset',
  'pre-restore': 'before restore',
};

/** Settings → Backups (F32): list, "Back up now", how to restore, and factory reset. */
export function BackupsSection() {
  const qc = useQueryClient();
  const router = useRouter();
  const { data, error } = useQuery({ queryKey: queryKeys.backups, queryFn: systemApi.backups });
  const [resetOpen, setResetOpen] = useState(false);
  const [confirm, setConfirm] = useState('');

  const backup = useMutation({
    mutationFn: systemApi.backupNow,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.backups });
      toast.success('Backup written');
    },
    onError: (err) => toast.error(`Backup failed: ${err.message}`),
  });

  const reset = useMutation({
    mutationFn: systemApi.factoryReset,
    onSuccess: (res) => {
      setResetOpen(false);
      setConfirm('');
      // Everything is gone: drop every cached query and go back to the first-run wizard.
      qc.clear();
      router.push('/');
      toast.success(`Factory reset done. Your data was backed up first to ${res.backup.path}`);
    },
    onError: (err) => toast.error(`Reset failed: ${err.message}`),
  });

  const latest = data?.backups[0];

  return (
    <section aria-labelledby="backups-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <h2 id="backups-heading" className="text-lg font-semibold">
            Backups
          </h2>
          <p className="text-sm text-muted-foreground">
            A backup holds the database, the team share and the bot homes (caches left out). Engine logins and
            tokens are never included. The first launch of each day makes one automatically; the last{' '}
            {DAILY_BACKUPS_KEPT} daily ones are kept, manual ones are kept until you delete the folder.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => backup.mutate()} disabled={backup.isPending}>
          <Archive />
          {backup.isPending ? 'Backing up…' : 'Back up now'}
        </Button>
      </div>

      {error ? (
        <p className="text-sm text-destructive">Could not load backups: {error.message}</p>
      ) : !data ? (
        <div className="h-16 animate-pulse rounded-lg border bg-muted/40" aria-busy="true" />
      ) : data.backups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No backups yet.</p>
      ) : (
        <ul aria-label="Backups" className="divide-y rounded-lg border text-sm">
          {data.backups.slice(0, 15).map((b) => (
            <li
              key={b.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
              data-testid="backup-row"
            >
              <span className="font-medium">{new Date(b.createdAt).toLocaleString()}</span>
              <span className="rounded-full border px-2 py-0.5 text-xs">{REASON_LABEL[b.reason]}</span>
              <span className="text-xs text-muted-foreground">
                {formatBytes(b.files.db + b.files.shared + b.files.bots)}
              </span>
              <code className="ml-auto break-all text-xs text-muted-foreground">{b.path}</code>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-lg border bg-muted/30 p-3 text-sm">
        <p className="font-medium">Restore a backup</p>
        <p className="text-muted-foreground">
          In the sandbox terminal, run the command below. It stops the app and the bot computers, saves the
          current data as one more backup, then puts the chosen backup back. Start the app again with{' '}
          <code>pnpm dev</code>.
        </p>
        <pre className="mt-2 overflow-x-auto rounded bg-background p-2 font-mono text-xs">
          pnpm restore {latest ? latest.path : `${data?.dir ?? 'data/backups'}/<backup folder>`}
        </pre>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 p-3">
        <div className="space-y-1 text-sm">
          <p className="font-medium text-destructive">Factory reset</p>
          <p className="text-muted-foreground">
            Deletes every bot, chat, task, memory, setting and file, after backing them up. Engine logins
            stay.
          </p>
        </div>
        <Button variant="destructive" size="sm" onClick={() => setResetOpen(true)}>
          <TriangleAlert />
          Factory reset…
        </Button>
      </div>

      <Dialog
        open={resetOpen}
        onClose={() => {
          setResetOpen(false);
          setConfirm('');
        }}
        title="Factory reset?"
        description={`A backup is written first, then every bot, chat, task, memory, setting and file is deleted and the bot computers are removed. Type ${FACTORY_RESET_WORD} to confirm.`}
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (confirm === FACTORY_RESET_WORD) reset.mutate();
          }}
        >
          <Input
            aria-label={`Type ${FACTORY_RESET_WORD} to confirm`}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="off"
            placeholder={FACTORY_RESET_WORD}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setResetOpen(false);
                setConfirm('');
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={confirm !== FACTORY_RESET_WORD || reset.isPending}
            >
              {reset.isPending ? 'Resetting…' : 'Reset everything'}
            </Button>
          </div>
        </form>
      </Dialog>
    </section>
  );
}
