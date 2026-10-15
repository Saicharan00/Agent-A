import { cn } from '@/lib/utils';

/** Renders "Ctrl+K" as <kbd>Ctrl</kbd><kbd>K</kbd>. */
export function KeyboardShortcut({ combo, className }: { combo: string; className?: string }) {
  const keys = combo.split('+');
  return (
    // aria-label isn't allowed on a plain span: screen readers get the combo as hidden text instead.
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      <span className="sr-only">{combo}</span>
      {keys.map((k, i) => (
        <kbd
          key={i}
          aria-hidden
          className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1 font-mono text-[10px] font-medium text-muted-foreground"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}
