'use client';

import type { BotView } from '@agenta/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/form';
import { botsApi } from '@/lib/bots';
import { queryKeys } from '@/lib/query-keys';
import { toast } from '@/lib/toast';

/** Permanent delete: the user types the bot's exact name; the home folder is only removed when ticked. */
export function DeleteBotDialog({
  bot,
  open,
  onClose,
  onDeleted,
}: {
  bot: BotView;
  open: boolean;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const [deleteHome, setDeleteHome] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed === bot.name;

  function close() {
    setTyped('');
    setDeleteHome(false);
    setError(null);
    onClose();
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!matches) return;
    setPending(true);
    setError(null);
    try {
      await botsApi.delete(bot.id, { confirmName: typed, deleteHome });
      toast.success(`${bot.name} deleted`);
      close();
      onDeleted?.();
      // Lists only: the deleted bot's detail would refetch into a 404 (it ages out of the cache instead).
      void qc.invalidateQueries({ queryKey: queryKeys.bots });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the bot');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={`Delete ${bot.name}?`}
      description="This permanently removes the bot, its computer, its DM thread and its run history. It cannot be undone. Archive instead to keep everything."
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label={`Type ${bot.name} to confirm`} htmlFor="delete-confirm">
          <Input
            id="delete-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            autoFocus
          />
        </Field>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={deleteHome}
            onChange={(e) => setDeleteHome(e.target.checked)}
            className="mt-0.5 size-4 accent-destructive"
          />
          <span>
            Also delete its home folder
            <span className="block text-xs text-muted-foreground">
              Files the bot created in /home/bot. Unticked, they stay in data/bots/{bot.id}.
            </span>
          </span>
        </label>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="destructive" disabled={!matches || pending}>
            {pending ? 'Deleting…' : 'Delete bot'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
