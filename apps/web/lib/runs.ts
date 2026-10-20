// A bot's run history for the Computer panel's Runs tab: the API call and how each run is labelled.
import { type RunView, runViewSchema } from '@agenta/shared';
import { z } from 'zod';
import type { PillTone } from '@/components/status-pill';
import { apiRequest } from './api';

/** Newest runs shown per bot. */
export const BOT_RUNS_LIMIT = 50;

export const runsApi = {
  forBot: (botId: string) =>
    apiRequest('/runs', z.array(runViewSchema), { query: { botId, limit: BOT_RUNS_LIMIT } }),
};

const STATUS_VIEW: Record<RunView['status'], { label: string; tone: PillTone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'ok' },
  succeeded: { label: 'Done', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'error' },
  cancelled: { label: 'Stopped', tone: 'neutral' },
  limited: { label: 'Limited', tone: 'warn' },
};

export function runStatusView(status: RunView['status']): { label: string; tone: PillTone } {
  return STATUS_VIEW[status];
}

/** What started the run, in the owner's words. */
export const RUN_TRIGGER_LABELS: Record<RunView['trigger'], string> = {
  user: 'Your message',
  mention: 'Mentioned',
  delegation: 'Delegated',
  task: 'Task',
  schedule: 'Schedule',
  review: 'Review',
};
