'use client';

import type { ReactNode } from 'react';
import { CommandPalette } from './command-palette';
import { ComputerPanel } from './computer-panel';
import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';

/** Grok Bot–style frame: sidebar | (top bar / page) | Computer panel. Only the page area scrolls. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main id="main" className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
      <ComputerPanel />
      <CommandPalette />
    </div>
  );
}
