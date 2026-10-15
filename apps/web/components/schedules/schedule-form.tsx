'use client';

import { DEFAULT_SCHEDULE_TIMEZONE, type ScheduleView } from '@agenta/shared';
import { useAppSettings } from '@/components/settings/general-section';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea, invalidProps } from '@/components/ui/form';
import { useBots } from '@/hooks/use-bots';
import { useScheduleActions } from '@/hooks/use-schedules';
import { queryKeys } from '@/lib/query-keys';
import {
  DAY_NAMES,
  PRESET_KINDS,
  PRESET_LABELS,
  type PresetKind,
  cronToPreset,
  presetToCron,
} from '@/lib/schedules';
import { threadsApi } from '@/lib/threads';

const NEW_THREAD = '';

/** Create a schedule, or edit `schedule`. Cron comes from a friendly preset or is typed raw. */
export function ScheduleForm({ schedule, onDone }: { schedule?: ScheduleView; onDone: () => void }) {
  const bots = useBots();
  const groups = useQuery({ queryKey: queryKeys.groups, queryFn: threadsApi.groups });
  const { create, update } = useScheduleActions();
  const initial = cronToPreset(schedule?.cron ?? '0 9 * * 1-5');
  const [name, setName] = useState(schedule?.name ?? '');
  const [botId, setBotId] = useState(schedule?.botId ?? '');
  const [prompt, setPrompt] = useState(schedule?.prompt ?? '');
  const [kind, setKind] = useState<PresetKind>(initial.kind);
  const [time, setTime] = useState(initial.time);
  const [day, setDay] = useState(initial.day);
  const [rawCron, setRawCron] = useState(initial.cron);
  const appSettings = useAppSettings();
  const [tzInput, setTimezone] = useState<string | undefined>(schedule?.timezone);
  // New schedules start in the owner's time zone (Settings → General).
  const timezone = tzInput ?? appSettings.data?.timezone ?? DEFAULT_SCHEDULE_TIMEZONE;
  const [threadId, setThreadId] = useState(schedule?.threadId ?? NEW_THREAD);
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [catchUp, setCatchUp] = useState(schedule?.catchUp ?? false);
  const [error, setError] = useState<string>();

  const bot = bots.data?.find((b) => b.id === (botId || bots.data?.[0]?.id));
  const cron = presetToCron({ kind, time, day, cron: rawCron });
  const pending = create.isPending || update.isPending;

  function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!name.trim() || !prompt.trim() || !bot || !cron.trim()) {
      return setError('Give the schedule a name, a bot, a prompt and a time');
    }
    setError(undefined);
    const body = {
      name,
      botId: bot.id,
      prompt,
      cron,
      timezone,
      threadId: threadId || null,
      enabled,
      catchUp,
    };
    const opts = { onSuccess: onDone, onError: (err: Error) => setError(err.message) };
    if (schedule) update.mutate({ id: schedule.id, ...body }, opts);
    else create.mutate(body, opts);
  }

  const id = (f: string) => `schedule-${schedule?.id ?? 'new'}-${f}`;
  return (
    <form
      onSubmit={submit}
      aria-label={schedule ? `Edit ${schedule.name}` : 'New schedule'}
      className="space-y-3 rounded-xl border bg-card p-4"
    >
      <h2 className="text-base font-semibold">{schedule ? `Edit ${schedule.name}` : 'New schedule'}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor={id('name')}>
          <Input id={id('name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Bot" htmlFor={id('bot')}>
          <Select id={id('bot')} value={bot?.id ?? ''} onChange={(e) => setBotId(e.target.value)}>
            {bots.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Prompt" htmlFor={id('prompt')} error={error}>
        <Textarea
          id={id('prompt')}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What the bot should do each time"
          {...invalidProps(id('prompt'), error)}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Repeat" htmlFor={id('repeat')}>
          <Select id={id('repeat')} value={kind} onChange={(e) => setKind(e.target.value as PresetKind)}>
            {PRESET_KINDS.map((k) => (
              <option key={k} value={k}>
                {PRESET_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        {kind === 'weekly' && (
          <Field label="Day" htmlFor={id('day')}>
            <Select id={id('day')} value={day} onChange={(e) => setDay(Number(e.target.value))}>
              {DAY_NAMES.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {kind === 'custom' ? (
          <Field label="Cron" htmlFor={id('cron')} hint="minute hour day-of-month month day-of-week">
            <Input
              id={id('cron')}
              value={rawCron}
              onChange={(e) => setRawCron(e.target.value)}
              className="font-mono"
            />
          </Field>
        ) : (
          <Field
            label={kind === 'hourly' ? 'Minute past (HH:MM)' : 'Time'}
            htmlFor={id('time')}
            hint={`cron ${cron}`}
          >
            <Input id={id('time')} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Time zone" htmlFor={id('tz')} hint="IANA name, e.g. America/New_York">
          <Input id={id('tz')} value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </Field>
        <Field label="Post in" htmlFor={id('thread')}>
          <Select id={id('thread')} value={threadId} onChange={(e) => setThreadId(e.target.value)}>
            <option value={NEW_THREAD}>A new thread each run</option>
            {bot?.dmThreadId && <option value={bot.dmThreadId}>Direct messages with {bot.name}</option>}
            {groups.data
              ?.filter((g) => !g.archivedAt)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  Group: {g.title}
                </option>
              ))}
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={catchUp} onChange={(e) => setCatchUp(e.target.checked)} />
          Catch up if missed (runs once when the app is back, or after an engine limit resets)
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : schedule ? 'Save' : 'Create schedule'}
        </Button>
      </div>
    </form>
  );
}
