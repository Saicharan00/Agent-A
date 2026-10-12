import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type PillTone = 'ok' | 'warn' | 'error' | 'neutral';

const TONES: Record<PillTone, { pill: string; dot: string }> = {
  ok: { pill: 'border-success/30 text-success', dot: 'bg-success' },
  warn: { pill: 'border-warning/40 text-warning', dot: 'bg-warning' },
  error: { pill: 'border-destructive/40 text-destructive', dot: 'bg-destructive' },
  neutral: { pill: 'border-border text-muted-foreground', dot: 'bg-muted-foreground/60' },
};

export function StatusPill({
  tone,
  children,
  className,
  ...props
}: { tone: PillTone; children: ReactNode } & ComponentProps<'span'>) {
  return (
    <span
      data-tone={tone}
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap',
        TONES[tone].pill,
        className,
      )}
      {...props}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', TONES[tone].dot)} />
      {children}
    </span>
  );
}
