'use client';

import type { GuardTermKind } from '@agenta/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, invalidProps } from '@/components/ui/form';
import { guardApi } from '@/lib/guard';
import { queryKeys } from '@/lib/query-keys';
import { toast } from '@/lib/toast';

/** Settings → Confidentiality guard (F24): the owner's guard terms (company, codenames, clients). */
export function GuardSection() {
  const qc = useQueryClient();
  const terms = useQuery({ queryKey: queryKeys.guardTerms, queryFn: guardApi.terms });
  const [term, setTerm] = useState('');
  const [kind, setKind] = useState<GuardTermKind>('literal');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const refresh = () => void qc.invalidateQueries({ queryKey: queryKeys.guardTerms });

  const create = useMutation({
    mutationFn: () => guardApi.createTerm({ term: term.trim(), kind, note: note.trim() }),
    onSuccess: () => {
      setTerm('');
      setNote('');
      setError(undefined);
      refresh();
    },
    onError: (err) => setError(err.message),
  });
  const remove = useMutation({
    mutationFn: guardApi.deleteTerm,
    onSuccess: refresh,
    onError: (err) => toast.error(`Could not delete: ${err.message}`),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (term.trim()) create.mutate();
  };

  return (
    <section aria-labelledby="guard-heading" className="flex flex-col gap-4">
      <div className="space-y-1">
        <h2 id="guard-heading" className="text-lg font-semibold">
          Confidentiality guard
        </h2>
        <p className="text-sm text-muted-foreground">
          Messages, uploads, memories and briefs are checked for keys, private keys, emails, IP addresses,
          internal hostnames, long pasted code and these guard terms. Guard terms stay on this computer and
          are never sent to an engine.
        </p>
      </div>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <Field label="Term" htmlFor="guard-term" error={error} className="min-w-48 flex-1">
          <Input
            id="guard-term"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder={kind === 'regex' ? 'project-(falcon|hawk)' : 'Company name, codename, client'}
            maxLength={500}
            {...invalidProps('guard-term', error)}
          />
        </Field>
        <Field label="Match" htmlFor="guard-kind">
          <Select id="guard-kind" value={kind} onChange={(e) => setKind(e.target.value as GuardTermKind)}>
            <option value="literal">Text</option>
            <option value="regex">Regex</option>
          </Select>
        </Field>
        <Field label="Note" htmlFor="guard-note" className="min-w-32 flex-1">
          <Input
            id="guard-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. client"
            maxLength={500}
          />
        </Field>
        <Button type="submit" disabled={!term.trim() || create.isPending}>
          <Plus />
          Add term
        </Button>
      </form>
      {terms.data && terms.data.length > 0 ? (
        <ul className="divide-y rounded-lg border" aria-label="Guard terms">
          {terms.data.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <code className="truncate">{t.term}</code>
              <span className="text-xs text-muted-foreground">{t.kind === 'regex' ? 'regex' : 'text'}</span>
              {t.note && <span className="truncate text-xs text-muted-foreground">· {t.note}</span>}
              <span className="flex-1" />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete guard term ${t.term}`}
                onClick={() => remove.mutate(t.id)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          {terms.isLoading ? 'Loading…' : 'No guard terms yet.'}
        </p>
      )}
    </section>
  );
}
