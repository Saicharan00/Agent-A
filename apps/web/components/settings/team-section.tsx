'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';

/** Settings → Team: "Reset team to defaults" (F21). */
export function TeamSection() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const reset = useMutation({
    mutationFn: () => api.resetTeam(),
    onSuccess: (res) => {
      setOpen(false);
      // Bots, the Lead Room and DMs may all be new: refetch everything.
      void queryClient.invalidateQueries();
      const parts = [
        res.created.length ? `added ${res.created.join(', ')}` : '',
        res.restored.length ? `restored ${res.restored.length} bots` : '',
      ].filter(Boolean);
      toast.success(`Team reset to defaults: ${parts.join('; ') || 'nothing to change'}.`);
    },
    onError: (err) => toast.error(`Reset failed: ${err.message}`),
  });

  return (
    <section aria-labelledby="team-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <h2 id="team-heading" className="text-lg font-semibold">
            Team
          </h2>
          <p className="text-sm text-muted-foreground">
            Agent A and six specialists, from templates/team. Resetting brings back missing team bots and the
            Lead Room, and restores each team bot&apos;s role, instructions and skills. Chats, tasks, memory
            and files are kept; engines, names and avatars stay as you set them.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <RotateCcw />
          Reset team to defaults
        </Button>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Reset team to defaults?"
        description="Your edits to the team bots' roles, instructions and skills are replaced by the defaults. Nothing else is deleted."
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => reset.mutate()} disabled={reset.isPending}>
            Reset team
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
