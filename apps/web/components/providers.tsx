'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Toaster } from 'sonner';
import type { Theme } from '@/lib/theme';
import { LiveProvider } from './live-provider';
import { ShellProvider, useShell } from './shell/shell-context';

function ThemedToaster() {
  const { theme } = useShell();
  return <Toaster theme={theme} position="bottom-right" closeButton richColors />;
}

export function Providers({ children, initialTheme }: { children: ReactNode; initialTheme: Theme }) {
  // One client per browser session (useState keeps it stable across renders).
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false } },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <LiveProvider>
        <ShellProvider initialTheme={initialTheme}>
          {children}
          <ThemedToaster />
        </ShellProvider>
      </LiveProvider>
    </QueryClientProvider>
  );
}
