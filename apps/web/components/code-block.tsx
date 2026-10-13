'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { highlight, languageLabel } from '@/lib/highlight';
import { toast } from '@/lib/toast';

/** A fenced code block: plain text at once, shiki colours once loaded, and a copy button. */
export function CodeBlock({ code, className }: { code: string; className?: string }) {
  const [html, setHtml] = useState<{ code: string; html: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    highlight(code, className)
      .then((out) => alive && setHtml({ code, html: out }))
      .catch(() => undefined); // keep the plain block
    return () => {
      alive = false;
    };
  }, [code, className]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      toast.error('Could not copy to the clipboard');
    }
  };

  const lang = languageLabel(className);
  return (
    <div className="group/code relative rounded-md border bg-muted/60" data-testid="code-block">
      <div className="flex h-8 items-center justify-between border-b px-3 text-xs text-muted-foreground">
        <span className="font-mono">{lang || 'text'}</span>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-accent-foreground"
          aria-label="Copy code"
        >
          {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {/* Stale highlight while streaming would show old text: only use it for the current code. */}
      {html && html.code === code ? (
        <div className="code-html" dangerouslySetInnerHTML={{ __html: html.html }} />
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
