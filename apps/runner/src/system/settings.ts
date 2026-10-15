import type { Repos } from '@agenta/db';
import {
  type AppSettingsUpdate,
  type BotDefaults,
  DEFAULT_APP_TIMEZONE,
  DEFAULT_BOT_DEFAULTS,
  botDefaultsSchema,
} from '@agenta/shared';

const TIMEZONE_KEY = 'app.timezone';
const BOT_DEFAULTS_KEY = 'app.botDefaults';

/** Owner-editable app settings (F31), stored in the `settings` table. Bad stored values fall back to defaults. */
export function readAppSettings(repos: Pick<Repos, 'settings'>): {
  timezone: string;
  botDefaults: BotDefaults;
} {
  const tz = repos.settings.get<unknown>(TIMEZONE_KEY);
  const defaults = botDefaultsSchema.safeParse(repos.settings.get<unknown>(BOT_DEFAULTS_KEY));
  return {
    timezone: typeof tz === 'string' && tz ? tz : DEFAULT_APP_TIMEZONE,
    botDefaults: defaults.success ? defaults.data : DEFAULT_BOT_DEFAULTS,
  };
}

export function writeAppSettings(repos: Pick<Repos, 'settings'>, update: AppSettingsUpdate): void {
  if (update.timezone !== undefined) repos.settings.set(TIMEZONE_KEY, update.timezone);
  if (update.botDefaults !== undefined) repos.settings.set(BOT_DEFAULTS_KEY, update.botDefaults);
}
