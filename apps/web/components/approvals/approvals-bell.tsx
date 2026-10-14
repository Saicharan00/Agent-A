'use client';

import { Bell } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { usePendingApprovals } from '@/hooks/use-approvals';
import { ApprovalList } from './approval-card';

/** Top-bar bell: a badge with the pending approval count and a dropdown to decide them (F27 adds notifications). */
export function ApprovalsBell() {
  const { data } = usePendingApprovals();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const count = data?.length ?? 0;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = count ? `Notifications: ${count} approval${count === 1 ? '' : 's'} waiting` : 'Notifications';
  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
        data-testid="notifications-bell"
      >
        <Bell />
        {count > 0 && (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-4 font-semibold text-white"
          >
            {count}
          </span>
        )}
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Approvals"
          className="absolute right-0 z-50 mt-2 max-h-[70vh] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border bg-popover p-3 shadow-lg"
        >
          <h2 className="mb-2 text-sm font-semibold">Approvals</h2>
          {count ? (
            <ApprovalList approvals={data ?? []} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {data ? 'Nothing is waiting for your approval.' : 'Loading…'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
