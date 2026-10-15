import { Download } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { buildApiUrl } from '@/lib/api';
import { cn } from '@/lib/utils';

/** "Export Markdown" (F32): a plain download link to a runner /api/export/* endpoint. */
export function ExportLink({
  path,
  label = 'Export',
  className,
}: {
  path: string;
  label?: string;
  className?: string;
}) {
  return (
    <a
      href={buildApiUrl(path)}
      download
      title="Download as Markdown"
      className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), className)}
    >
      <Download aria-hidden />
      {label}
    </a>
  );
}
