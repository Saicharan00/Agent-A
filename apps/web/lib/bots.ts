// Bot management logic for the UI (F12): API calls, and the form ↔ request mapping with field-level errors.
// Components stay thin: they render `BotFormValues` and call these helpers.
import {
  type AvatarShape,
  type BotCreateRequest,
  type BotUpdateRequest,
  type BotView,
  type Engine,
  type NotificationLevel,
  botCreateRequestSchema,
  botUpdateResponseSchema,
  botViewSchema,
  desktopScreenshotSchema,
} from '@agenta/shared';
import { z } from 'zod';
import { apiRequest } from './api';

export const AVATAR_COLORS = [
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#10b981',
  '#06b6d4',
  '#3b82f6',
  '#64748b',
] as const;

/** Form state: numbers as strings (what inputs hold), model '' = engine default. */
export type BotFormValues = {
  name: string;
  slug: string;
  role: string;
  instructions: string;
  engine: Engine;
  model: string;
  avatarColor: string;
  avatarShape: AvatarShape;
  notifications: NotificationLevel;
  sidebarVisible: boolean;
  memoryMb: string;
  cpus: string;
  idleTimeoutMin: string;
  runTimeoutMin: string;
};
export type BotFormField = keyof BotFormValues;
export type BotFormErrors = Partial<Record<BotFormField, string>>;

/** Same slug rule as the runner (packages/db slugify): what the handle becomes when left blank. */
export function slugPreview(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || 'bot';
}

export function defaultBotForm(): BotFormValues {
  return {
    name: '',
    slug: '',
    role: '',
    instructions: '',
    engine: 'claude',
    model: '',
    avatarColor: AVATAR_COLORS[0],
    avatarShape: 'circle',
    notifications: 'all',
    sidebarVisible: true,
    memoryMb: '2048',
    cpus: '2',
    idleTimeoutMin: '30',
    runTimeoutMin: '',
  };
}

export function botToForm(bot: BotView): BotFormValues {
  return {
    name: bot.name,
    slug: bot.slug,
    role: bot.role,
    instructions: bot.instructions,
    engine: bot.engine,
    model: bot.model ?? '',
    avatarColor: bot.avatarColor,
    avatarShape: bot.avatarShape,
    notifications: bot.notifications,
    sidebarVisible: bot.sidebarVisible,
    memoryMb: String(bot.settings.memoryMb),
    cpus: String(bot.settings.cpus),
    idleTimeoutMin: String(bot.settings.idleTimeoutMin),
    runTimeoutMin: bot.settings.runTimeoutMin === undefined ? '' : String(bot.settings.runTimeoutMin),
  };
}

const SETTINGS_FIELDS = { memoryMb: 'memoryMb', cpus: 'cpus', idleTimeoutMin: 'idleTimeoutMin' } as const;

/** Maps a zod issue path (e.g. ['settings', 'memoryMb']) to the form field that shows it. */
function fieldOf(path: PropertyKey[]): BotFormField | null {
  const [head, sub] = path;
  if (head === 'settings') {
    if (sub === 'runTimeoutMin') return 'runTimeoutMin';
    return sub && sub in SETTINGS_FIELDS ? (sub as BotFormField) : null;
  }
  return typeof head === 'string' && head in defaultBotForm() ? (head as BotFormField) : null;
}

const num = (s: string) => (s.trim() === '' ? Number.NaN : Number(s));

/**
 * Validates the form with the runner's own schema and builds the request body. `flags` (advanced settings not in
 * the form) are carried over from `base` so saving never drops them.
 */
export function formToRequest(
  values: BotFormValues,
  base?: Pick<BotView, 'settings'>,
): { ok: true; body: BotCreateRequest } | { ok: false; errors: BotFormErrors } {
  const body: BotCreateRequest = {
    name: values.name.trim(),
    ...(values.slug.trim() ? { slug: values.slug.trim() } : {}),
    role: values.role.trim(),
    instructions: values.instructions,
    engine: values.engine,
    model: values.model.trim() || null,
    avatarColor: values.avatarColor,
    avatarShape: values.avatarShape,
    notifications: values.notifications,
    sidebarVisible: values.sidebarVisible,
    settings: {
      memoryMb: num(values.memoryMb),
      cpus: num(values.cpus),
      idleTimeoutMin: num(values.idleTimeoutMin),
      ...(values.runTimeoutMin.trim() ? { runTimeoutMin: num(values.runTimeoutMin) } : {}),
      flags: base?.settings.flags ?? {},
    },
  };
  const parsed = botCreateRequestSchema.safeParse(body);
  if (parsed.success) return { ok: true, body };
  const errors: BotFormErrors = {};
  for (const issue of parsed.error.issues) {
    const field = fieldOf(issue.path);
    if (field && !errors[field]) errors[field] = friendlyMessage(field, issue.message);
  }
  if (Object.keys(errors).length === 0) errors.name = parsed.error.issues[0]?.message ?? 'Invalid bot';
  return { ok: false, errors };
}

function friendlyMessage(field: BotFormField, raw: string): string {
  switch (field) {
    case 'name':
      return 'Name is required (up to 64 characters).';
    case 'slug':
      return 'Use lowercase letters, digits and single dashes.';
    case 'memoryMb':
      return 'RAM must be a whole number between 256 and 65536 MB.';
    case 'cpus':
      return 'CPUs must be more than 0 and at most 16.';
    case 'idleTimeoutMin':
      return 'Idle timeout must be 0–1440 minutes (0 = never).';
    case 'runTimeoutMin':
      return 'Run timeout must be 1–1440 minutes, or empty for the default.';
    default:
      return raw;
  }
}

/** JSON with object keys sorted, so equal values compare equal whatever their key order. */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );
}

/** Only the fields that differ from the saved bot (PATCH body). */
export function changedFields(body: BotCreateRequest, bot: BotView): BotUpdateRequest {
  const out: Record<string, unknown> = {};
  const current: Record<string, unknown> = { ...bot };
  for (const [k, v] of Object.entries(body)) {
    if (stableJson(v) !== stableJson(current[k])) out[k] = v;
  }
  return out as BotUpdateRequest;
}

/** Grid order: the lead first, then most recently active, then newest. */
export function sortBots(bots: BotView[]): BotView[] {
  return [...bots].sort(
    (a, b) =>
      Number(b.isLead) - Number(a.isLead) ||
      (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') ||
      b.createdAt.localeCompare(a.createdAt),
  );
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", else a local date. */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'No activity yet';
  const diff = Math.max(0, now - Date.parse(iso));
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}

const botList = z.array(botViewSchema);
const noContent = z.unknown();

export const botsApi = {
  list: (archived: 'exclude' | 'include' | 'only' = 'exclude') =>
    apiRequest('/bots', botList, { query: { archived } }),
  get: (id: string) => apiRequest(`/bots/${encodeURIComponent(id)}`, botViewSchema),
  create: (body: BotCreateRequest) => apiRequest('/bots', botViewSchema, { method: 'POST', body }),
  update: (id: string, body: BotUpdateRequest) =>
    apiRequest(`/bots/${encodeURIComponent(id)}`, botUpdateResponseSchema, { method: 'PATCH', body }),
  archive: (id: string) =>
    apiRequest(`/bots/${encodeURIComponent(id)}/archive`, botViewSchema, { method: 'POST' }),
  restore: (id: string) =>
    apiRequest(`/bots/${encodeURIComponent(id)}/restore`, botViewSchema, { method: 'POST' }),
  duplicate: (id: string, name?: string) =>
    apiRequest(`/bots/${encodeURIComponent(id)}/duplicate`, botViewSchema, {
      method: 'POST',
      body: name ? { name } : {},
    }),
  delete: (id: string, body: { confirmName: string; deleteHome: boolean }) =>
    apiRequest(`/bots/${encodeURIComponent(id)}`, noContent, { method: 'DELETE', body }),
  stopComputer: (id: string) =>
    apiRequest(`/bots/${encodeURIComponent(id)}/computer/stop`, noContent, { method: 'POST' }),
  startComputer: (id: string) =>
    apiRequest(`/bots/${encodeURIComponent(id)}/computer/start`, noContent, { method: 'POST' }),
  screenshot: (id: string) =>
    apiRequest(`/bots/${encodeURIComponent(id)}/computer/screenshot`, desktopScreenshotSchema, {
      method: 'POST',
    }),
};
