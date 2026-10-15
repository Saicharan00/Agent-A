'use client';

import type { AppSettings } from '@agenta/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { useShell } from '@/components/shell/shell-context';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/form';
import { queryKeys } from '@/lib/query-keys';
import { systemApi, timeZones } from '@/lib/system';
import { toast } from '@/lib/toast';

export function useAppSettings() {
  return useQuery({ queryKey: queryKeys.appSettings, queryFn: systemApi.appSettings });
}

const PATH_LABELS: [keyof AppSettings['paths'], string][] = [
  ['data', 'Data folder'],
  ['db', 'Database'],
  ['bots', 'Bot homes'],
  ['shared', 'Team share'],
  ['secrets', 'Secrets (never backed up or shown)'],
  ['backups', 'Backups'],
];

/** Settings → General: theme, time zone, resource defaults for new bots, where the data lives (F31). */
export function GeneralSection() {
  const qc = useQueryClient();
  const { theme, setTheme } = useShell();
  const { data, error } = useAppSettings();
  const [timezone, setTimezone] = useState('');
  const [cpus, setCpus] = useState('');
  const [memoryMb, setMemoryMb] = useState('');
  const [idle, setIdle] = useState('');

  useEffect(() => {
    if (!data) return;
    setTimezone(data.timezone);
    setCpus(String(data.botDefaults.cpus));
    setMemoryMb(String(data.botDefaults.memoryMb));
    setIdle(String(data.botDefaults.idleTimeoutMin));
  }, [data]);

  const save = useMutation({
    mutationFn: systemApi.saveAppSettings,
    onSuccess: (fresh) => {
      qc.setQueryData(queryKeys.appSettings, fresh);
      toast.success('Settings saved');
    },
    onError: (err) => toast.error(`Could not save: ${err.message}`),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate({
      timezone,
      botDefaults: { cpus: Number(cpus), memoryMb: Number(memoryMb), idleTimeoutMin: Number(idle) },
    });
  }

  return (
    <section aria-labelledby="general-heading" className="flex flex-col gap-4">
      <div className="space-y-1">
        <h2 id="general-heading" className="text-lg font-semibold">
          General
        </h2>
        <p className="text-sm text-muted-foreground">Appearance, time zone and defaults for new bots.</p>
      </div>
      <Field label="Theme" htmlFor="settings-theme" className="max-w-xs">
        <Select
          id="settings-theme"
          value={theme}
          onChange={(e) => setTheme(e.target.value === 'light' ? 'light' : 'dark')}
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </Select>
      </Field>
      {error && <p className="text-sm text-destructive">Could not load settings: {error.message}</p>}
      {data && (
        <form onSubmit={submit} aria-label="General settings" className="space-y-4">
          <Field
            label="Time zone"
            htmlFor="settings-timezone"
            hint="Default for new schedules."
            className="max-w-xs"
          >
            <Select id="settings-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {timeZones(timezone).map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </Select>
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Resources for new bots</legend>
            <p className="text-xs text-muted-foreground">
              New bots and newly created team bots start with these limits. Existing bots keep theirs.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="CPUs" htmlFor="settings-cpus">
                <Input
                  id="settings-cpus"
                  type="number"
                  min={0.5}
                  max={16}
                  step={0.5}
                  value={cpus}
                  onChange={(e) => setCpus(e.target.value)}
                />
              </Field>
              <Field label="Memory (MB)" htmlFor="settings-memory">
                <Input
                  id="settings-memory"
                  type="number"
                  min={256}
                  max={65536}
                  step={256}
                  value={memoryMb}
                  onChange={(e) => setMemoryMb(e.target.value)}
                />
              </Field>
              <Field label="Idle stop (min, 0 = never)" htmlFor="settings-idle">
                <Input
                  id="settings-idle"
                  type="number"
                  min={0}
                  max={1440}
                  value={idle}
                  onChange={(e) => setIdle(e.target.value)}
                />
              </Field>
            </div>
          </fieldset>
          <div className="flex justify-end">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      )}
      {data && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Where your data lives (inside the sandbox)</h3>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm" aria-label="Data folders">
            {PATH_LABELS.map(([key, label]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-all font-mono text-xs leading-5">{data.paths[key]}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  );
}
