// Scheduled tasks (F26): API client and the friendly cron presets of the schedule form.
import {
  type ScheduleCreateRequest,
  type ScheduleUpdateRequest,
  scheduleRunViewSchema,
  scheduleViewSchema,
} from '@agenta/shared';
import { z } from 'zod';
import { apiRequest } from './api';

const enc = encodeURIComponent;

export const schedulesApi = {
  list: () => apiRequest('/schedules', z.array(scheduleViewSchema)),
  create: (body: ScheduleCreateRequest) =>
    apiRequest('/schedules', scheduleViewSchema, { method: 'POST', body }),
  update: (id: string, body: ScheduleUpdateRequest) =>
    apiRequest(`/schedules/${enc(id)}`, scheduleViewSchema, { method: 'PATCH', body }),
  delete: (id: string) => apiRequest(`/schedules/${enc(id)}`, z.unknown(), { method: 'DELETE' }),
  runNow: (id: string) => apiRequest(`/schedules/${enc(id)}/run`, scheduleRunViewSchema, { method: 'POST' }),
  history: (id: string) => apiRequest(`/schedules/${enc(id)}/runs`, z.array(scheduleRunViewSchema)),
};

export const PRESET_KINDS = ['weekdays', 'daily', 'weekly', 'hourly', 'custom'] as const;
export type PresetKind = (typeof PRESET_KINDS)[number];
export const PRESET_LABELS: Record<PresetKind, string> = {
  weekdays: 'Every weekday',
  daily: 'Every day',
  weekly: 'Once a week',
  hourly: 'Every hour',
  custom: 'Custom cron',
};
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A preset: `time` is HH:MM (only the minutes matter for hourly), `day` 0–6 for weekly. */
export type Preset = { kind: PresetKind; time: string; day: number; cron: string };

export function presetToCron(p: Omit<Preset, 'cron'> & { cron?: string }): string {
  const [h, m] = p.time.split(':').map((x) => Number.parseInt(x, 10));
  const hh = Number.isFinite(h) ? h : 9;
  const mm = Number.isFinite(m) ? m : 0;
  switch (p.kind) {
    case 'weekdays':
      return `${mm} ${hh} * * 1-5`;
    case 'daily':
      return `${mm} ${hh} * * *`;
    case 'weekly':
      return `${mm} ${hh} * * ${p.day}`;
    case 'hourly':
      return `${mm} * * * *`;
    case 'custom':
      return p.cron ?? '';
  }
}

const pad = (n: string) => n.padStart(2, '0');

/** The preset a cron expression came from, or `custom`. */
export function cronToPreset(cron: string): Preset {
  const f = cron.trim().split(/\s+/);
  const num = (s: string | undefined, max: number) => !!s && /^\d+$/.test(s) && Number(s) <= max;
  if (f.length === 5 && num(f[0], 59) && f[2] === '*' && f[3] === '*') {
    const [m, h, , , dow] = f as [string, string, string, string, string];
    if (h === '*' && dow === '*') return { kind: 'hourly', time: `00:${pad(m)}`, day: 1, cron };
    if (num(h, 23)) {
      const time = `${pad(h)}:${pad(m)}`;
      if (dow === '1-5') return { kind: 'weekdays', time, day: 1, cron };
      if (dow === '*') return { kind: 'daily', time, day: 1, cron };
      if (num(dow, 6)) return { kind: 'weekly', time, day: Number(dow), cron };
    }
  }
  return { kind: 'custom', time: '09:00', day: 1, cron };
}

/** "Weekdays at 08:45", "Fridays at 16:45", "Every hour at :15", or the raw cron. */
export function describeCron(cron: string): string {
  const p = cronToPreset(cron);
  switch (p.kind) {
    case 'weekdays':
      return `Weekdays at ${p.time}`;
    case 'daily':
      return `Every day at ${p.time}`;
    case 'weekly':
      return `${DAY_NAMES[p.day]}s at ${p.time}`;
    case 'hourly':
      return `Every hour at :${p.time.slice(3)}`;
    case 'custom':
      return `cron ${cron}`;
  }
}
