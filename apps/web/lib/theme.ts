export type Theme = 'dark' | 'light';
export const DEFAULT_THEME: Theme = 'dark';

/**
 * The theme is persisted in localStorage (source of truth in the browser) and mirrored to this
 * cookie so the root layout can render the right class on the server: no flash, no inline script.
 */
export const THEME_COOKIE = 'agenta.theme';

export function parseTheme(value: string | null | undefined): Theme {
  return value === 'light' || value === 'dark' ? value : DEFAULT_THEME;
}

export function themeCookie(theme: Theme): string {
  return `${THEME_COOKIE}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
