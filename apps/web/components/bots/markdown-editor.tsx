'use client';

import { useState } from 'react';
import { Markdown } from '@/components/markdown';
import { Textarea, invalidProps } from '@/components/ui/form';
import { cn } from '@/lib/utils';

/** Markdown textarea with Write / Preview tabs. */
export function MarkdownEditor({
  id,
  label,
  value,
  onChange,
  error,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  placeholder?: string;
}) {
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const tab = (m: typeof mode, text: string) => (
    <button
      type="button"
      role="tab"
      id={`${id}-tab-${m}`}
      aria-selected={mode === m}
      aria-controls={`${id}-panel`}
      onClick={() => setMode(m)}
      className={cn(
        'rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground',
        mode === m && 'bg-accent text-accent-foreground',
      )}
    >
      {text}
    </button>
  );

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className={cn('text-sm font-medium', mode === 'preview' && 'sr-only')}>
          {label}
        </label>
        <div role="tablist" aria-label={`${label} editor`} className="ml-auto flex gap-1">
          {tab('write', 'Write')}
          {tab('preview', 'Preview')}
        </div>
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${mode}`}>
        {mode === 'write' ? (
          <Textarea
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            spellCheck
            className="min-h-64 font-mono text-[13px] leading-relaxed"
            {...invalidProps(id, error)}
          />
        ) : (
          <div className="min-h-64 rounded-md border px-4 py-3" data-testid={`${id}-preview`}>
            {value.trim() ? (
              <Markdown>{value}</Markdown>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing to preview.</p>
            )}
          </div>
        )}
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
