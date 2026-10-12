import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { AppShell } from '@/components/shell/app-shell';
import { parseTheme, THEME_COOKIE } from '@/lib/theme';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Agent A', template: '%s · Agent A' },
  description: 'Your AI team, led by Agent A.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Theme comes from a cookie so the first paint is already correct (see lib/theme.ts).
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" className={theme === 'dark' ? 'dark' : undefined} style={{ colorScheme: theme }}>
      <body className="antialiased">
        <Providers initialTheme={theme}>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
