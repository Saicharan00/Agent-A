'use client';

import { MessagesSquare, PanelLeftClose, PanelLeftOpen, Plus, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { BotAvatar } from '@/components/bot-avatar';
import { KeyboardShortcut } from '@/components/keyboard-shortcut';
import { Button } from '@/components/ui/button';
import { isActivePath, NAV_ITEMS } from '@/lib/nav';
import { SHORTCUTS } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { useShell } from './shell-context';

function Section({
  title,
  action,
  children,
  collapsed,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  collapsed: boolean;
}) {
  return (
    <div className="space-y-1">
      {!collapsed && (
        <div className="flex h-6 items-center justify-between px-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          <span>{title}</span>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

function NavLink({
  href,
  label,
  icon,
  collapsed,
  active,
}: {
  href: string;
  label: string;
  icon: ReactNode;
  collapsed: boolean;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground',
        active && 'bg-sidebar-accent font-medium text-sidebar-foreground',
        collapsed && 'justify-center px-0',
      )}
    >
      {icon}
      {!collapsed && <span className="truncate">{label}</span>}
      {collapsed && <span className="sr-only">{label}</span>}
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const { sidebarCollapsed: collapsed, toggleSidebar } = useShell();

  return (
    <aside
      aria-label="Sidebar"
      data-collapsed={collapsed}
      className={cn(
        'flex h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200',
        collapsed ? 'w-14' : 'w-64',
      )}
    >
      <div
        className={cn(
          'flex h-12 items-center gap-2 border-b border-sidebar-border px-3',
          collapsed && 'justify-center px-0',
        )}
      >
        {!collapsed && (
          <Link href="/" className="flex-1 truncate text-sm font-semibold tracking-tight">
            Agent A
          </Link>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggleSidebar}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={`${collapsed ? 'Expand' : 'Collapse'} sidebar (${SHORTCUTS.toggleSidebar})`}
        >
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </Button>
      </div>

      <nav aria-label="Main" className="flex-1 space-y-4 overflow-y-auto p-2">
        {/* Agent A is always pinned at the top. Real bot data arrives in F12. */}
        <Section title="Lead" collapsed={collapsed}>
          <Link
            href="/bots"
            title={collapsed ? 'Agent A' : undefined}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-sidebar-accent',
              collapsed && 'justify-center px-0',
            )}
          >
            <BotAvatar name="Agent A" color="#6366f1" shape="hexagon" status="stopped" size="sm" />
            {!collapsed && (
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">Agent A</span>
                <span className="block truncate text-xs text-muted-foreground">Lead AI Engineer</span>
              </span>
            )}
          </Link>
        </Section>

        <Section
          title="Bots"
          collapsed={collapsed}
          action={
            <Link
              href="/bots/new"
              aria-label="New bot"
              className="rounded p-0.5 hover:bg-sidebar-accent hover:text-foreground"
            >
              <Plus className="size-3.5" />
            </Link>
          }
        >
          {!collapsed && <p className="px-2 py-1 text-xs text-muted-foreground">No bots yet.</p>}
        </Section>

        <Section title="Groups" collapsed={collapsed}>
          {!collapsed && (
            <p className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
              <Users className="size-3.5" aria-hidden /> No group chats yet.
            </p>
          )}
        </Section>

        <Section title="Workspace" collapsed={collapsed}>
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
            <NavLink
              key={href}
              href={href}
              label={label}
              icon={<Icon className="size-4 shrink-0" aria-hidden />}
              collapsed={collapsed}
              active={isActivePath(pathname, href)}
            />
          ))}
        </Section>
      </nav>

      {!collapsed && (
        <div className="flex items-center justify-between border-t border-sidebar-border px-3 py-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <MessagesSquare className="size-3.5" aria-hidden /> Commands
          </span>
          <KeyboardShortcut combo={SHORTCUTS.palette} />
        </div>
      )}
    </aside>
  );
}
