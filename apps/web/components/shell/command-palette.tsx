'use client';

import { Command } from 'cmdk';
import { Monitor, Moon, PanelLeft, Sun, Target } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { NEW_GOAL_ANCHOR, focusNewGoal } from '@/components/goals/new-goal-form';
import { KeyboardShortcut } from '@/components/keyboard-shortcut';
import { NAV_ITEMS, NEW_BOT_ITEM } from '@/lib/nav';
import { SHORTCUTS } from '@/lib/shortcuts';
import { useShell } from './shell-context';

function Item({
  onSelect,
  icon,
  children,
  shortcut,
  keywords,
}: {
  onSelect: () => void;
  icon: ReactNode;
  children: string;
  shortcut?: string;
  keywords?: string[];
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      keywords={keywords}
      className="flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg]:size-4 [&_svg]:text-muted-foreground"
    >
      {icon}
      <span className="flex-1">{children}</span>
      {shortcut && <KeyboardShortcut combo={shortcut} />}
    </Command.Item>
  );
}

const groupClass =
  'px-1 py-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground';

/** Ctrl+K palette shell: navigation + UI commands. Search over threads/tasks arrives with real data. */
export function CommandPalette() {
  const router = useRouter();
  const pathname = usePathname();
  const { paletteOpen, setPaletteOpen, theme, toggleTheme, toggleSidebar, computerOpen, setComputerOpen } =
    useShell();

  const run = (fn: () => void) => () => {
    setPaletteOpen(false);
    fn();
  };

  return (
    <Command.Dialog
      open={paletteOpen}
      onOpenChange={setPaletteOpen}
      label="Command palette"
      overlayClassName="fixed inset-0 z-50 bg-black/50 backdrop-blur-[1px]"
      contentClassName="fixed top-[15vh] left-1/2 z-50 w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl"
    >
      <Command.Input
        placeholder="Type a command or search…"
        className="h-11 w-full border-b bg-transparent px-4 text-sm outline-none placeholder:text-muted-foreground"
      />
      <Command.List className="max-h-[min(60vh,400px)] overflow-y-auto p-1">
        <Command.Empty className="py-6 text-center text-sm text-muted-foreground">No results.</Command.Empty>
        <Command.Group heading="Agent A" className={groupClass}>
          <Item
            icon={<Target />}
            keywords={['goal', 'plan', 'delegate', 'agent a']}
            onSelect={run(() => {
              // On Home the form is already there: focus it once the palette has handed focus back.
              if (pathname === '/') setTimeout(focusNewGoal, 50);
              else router.push(`/#${NEW_GOAL_ANCHOR}`);
            })}
          >
            New goal
          </Item>
        </Command.Group>
        <Command.Group heading="Go to" className={groupClass}>
          {[...NAV_ITEMS, NEW_BOT_ITEM].map(({ href, label, icon: Icon, keywords }) => (
            <Item
              key={href}
              icon={<Icon />}
              keywords={keywords?.split(' ')}
              onSelect={run(() => router.push(href))}
            >
              {label}
            </Item>
          ))}
        </Command.Group>
        <Command.Group heading="Interface" className={groupClass}>
          <Item
            icon={theme === 'dark' ? <Sun /> : <Moon />}
            onSelect={run(toggleTheme)}
            keywords={['theme', 'dark', 'light']}
          >
            {theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          </Item>
          <Item icon={<PanelLeft />} onSelect={run(toggleSidebar)} shortcut={SHORTCUTS.toggleSidebar}>
            Toggle sidebar
          </Item>
          <Item
            icon={<Monitor />}
            onSelect={run(() => setComputerOpen(!computerOpen))}
            shortcut={SHORTCUTS.toggleComputer}
          >
            {computerOpen ? 'Close computer panel' : 'Open computer panel'}
          </Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
