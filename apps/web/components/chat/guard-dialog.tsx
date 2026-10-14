'use client';

import type { GuardFinding } from '@agenta/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

/** Long matches (a pasted code block) are shortened in the list. */
const preview = (s: string) => (s.length > 80 ? `${s.slice(0, 77).replace(/\s+/g, ' ')}…` : s);

/** Composer warning (F24): what the guard found, then Edit / Redact automatically / Send anyway. */
export function GuardDialog({
  findings,
  busy,
  onEdit,
  onRedact,
  onSendAnyway,
}: {
  findings: GuardFinding[] | null;
  busy: boolean;
  onEdit: () => void;
  onRedact: () => void;
  onSendAnyway: () => void;
}) {
  return (
    <Dialog
      open={findings !== null}
      onClose={onEdit}
      title="This message looks confidential"
      description="Agent A runs on your personal laptop. Check these before they reach a bot:"
    >
      <ul className="max-h-60 space-y-1 overflow-y-auto text-sm" data-testid="guard-findings">
        {findings?.map((f) => (
          <li key={`${f.kind}:${f.match}`} className="flex gap-2">
            <span className="shrink-0 font-medium">{f.label}</span>
            <code className="truncate rounded bg-muted px-1 text-xs leading-5">{preview(f.match)}</code>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onEdit}>
          Edit
        </Button>
        <Button variant="outline" onClick={onRedact} disabled={busy}>
          Redact automatically
        </Button>
        <Button variant="destructive" onClick={onSendAnyway} disabled={busy}>
          Send anyway
        </Button>
      </div>
    </Dialog>
  );
}
