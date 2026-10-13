'use client';

import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { Button } from './button';

/**
 * Modal built on the native <dialog> element: focus trap, Escape to close and the backdrop come for free.
 * Controlled by `open`; `onClose` fires on Escape, the close button or a backdrop click.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // backdrop
      }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border bg-popover p-0 text-popover-foreground shadow-xl backdrop:bg-black/50"
    >
      {open && (
        <div className="space-y-4 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h2 id="dialog-title" className="text-base font-semibold">
                {title}
              </h2>
              {description && <div className="text-sm text-muted-foreground">{description}</div>}
            </div>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close dialog">
              <X />
            </Button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
