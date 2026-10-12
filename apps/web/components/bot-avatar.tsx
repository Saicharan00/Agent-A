import type { AvatarShape, BotStatus } from '@agenta/shared';
import { initialsOf, readableTextColor, SHAPE_CLASS, STATUS_LABEL } from '@/lib/avatar';
import { cn } from '@/lib/utils';

const SIZES = { sm: 'size-7 text-[10px]', md: 'size-9 text-xs', lg: 'size-14 text-base' } as const;
const DOT_SIZES = { sm: 'size-2.5', md: 'size-3', lg: 'size-3.5' } as const;
const DOT_COLOR: Record<BotStatus, string> = {
  running: 'bg-success',
  starting: 'bg-warning animate-pulse',
  stopped: 'bg-muted-foreground/50',
  error: 'bg-destructive',
};

export function BotAvatar({
  name,
  color,
  shape = 'circle',
  status,
  size = 'md',
  className,
}: {
  name: string;
  color: string;
  shape?: AvatarShape;
  /** Omit to hide the status dot. */
  status?: BotStatus;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span className={cn('relative inline-flex shrink-0', className)} data-shape={shape}>
      <span
        aria-hidden
        className={cn(
          'flex items-center justify-center font-semibold select-none',
          SIZES[size],
          SHAPE_CLASS[shape],
        )}
        style={{ backgroundColor: color, color: readableTextColor(color) }}
      >
        {initialsOf(name)}
      </span>
      {status && (
        <span
          role="img"
          aria-label={STATUS_LABEL[status]}
          title={STATUS_LABEL[status]}
          data-status={status}
          className={cn(
            'absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-sidebar',
            DOT_SIZES[size],
            DOT_COLOR[status],
          )}
        />
      )}
      <span className="sr-only">{name}</span>
    </span>
  );
}
