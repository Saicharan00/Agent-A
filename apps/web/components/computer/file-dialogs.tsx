'use client';

import { type FormEvent, type ReactNode, useCallback, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/form';

type ConfirmOpts = { title: string; description: ReactNode; confirmLabel: string; destructive?: boolean };
type PromptOpts = { title: string; label: string; initial?: string; submitLabel: string };

type Pending =
  | ({ kind: 'confirm'; resolve: (ok: boolean) => void } & ConfirmOpts)
  | ({ kind: 'prompt'; resolve: (value: string | null) => void } & PromptOpts);

/**
 * Promise-based confirm / name prompts for the Files tab: `await confirm(...)`, `await prompt(...)`.
 * Render `dialog` once.
 */
export function useFileDialogs(): {
  dialog: ReactNode;
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  prompt: (opts: PromptOpts) => Promise<string | null>;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const confirm = useCallback(
    (opts: ConfirmOpts) =>
      new Promise<boolean>((resolve) => setPending({ kind: 'confirm', resolve, ...opts })),
    [],
  );
  const prompt = useCallback((opts: PromptOpts) => {
    setValue(opts.initial ?? '');
    return new Promise<string | null>((resolve) => {
      setPending({ kind: 'prompt', resolve, ...opts });
      // Select the name without its extension, like file managers do.
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        const dot = el.value.lastIndexOf('.');
        el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
      });
    });
  }, []);

  function close(result: boolean) {
    if (!pending) return;
    if (pending.kind === 'confirm') pending.resolve(result);
    else pending.resolve(result && value.trim() ? value.trim() : null);
    setPending(null);
  }

  function submit(ev: FormEvent) {
    ev.preventDefault();
    close(true);
  }

  const dialog = (
    <Dialog
      open={pending !== null}
      onClose={() => close(false)}
      title={pending?.title ?? ''}
      description={pending?.kind === 'confirm' ? pending.description : undefined}
    >
      <form onSubmit={submit} className="space-y-4">
        {pending?.kind === 'prompt' && (
          <Field label={pending.label} htmlFor="file-dialog-name">
            <Input
              id="file-dialog-name"
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant={pending?.kind === 'confirm' && pending.destructive ? 'destructive' : 'default'}
            disabled={pending?.kind === 'prompt' && !value.trim()}
          >
            {pending?.kind === 'confirm' ? pending.confirmLabel : pending?.submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );

  return { dialog, confirm, prompt };
}
