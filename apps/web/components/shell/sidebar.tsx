'use client';

import { BellOff, Hash, MessagesSquare, PanelLeftClose, PanelLeftOpen, Plus, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import type { BotView } from '@agenta/shared';
import { BotAvatar } from '@/components/bot-avatar';
import { NewGroupDialog } from '@/components/chat/group-dialogs';
import { KeyboardShortcut } from '@/components/keyboard-shortcut';
import { Button } from '@/components/ui/button';
import { useBots } from '@/hooks/use-bots';
import { useGroups, useUnreadCounts } from '@/hooks/use-thread';
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

/** A bot opens its DM thread (chat); a bot without one opens its settings. */
function botHref(bot: BotView): string {
  return bot.dmThreadId ? `/threads/${bot.dmThreadId}` : `/bots/${bot.id}`;
}

function BotLink({
  bot,
  subtitle,
  collapsed,
  active,
  unread = 0,
}: {
  bot: BotView;
  subtitle?: string;
  collapsed: boolean;
  active: boolean;
  /** Unseen messages in its DM (hidden while that chat is open). */
  unread?: number;
}) {
  const badge = active ? 0 : unread;
  return (
    <Link
      href={botHref(bot)}
      title={collapsed ? bot.name : undefined}
      aria-current={active ? 'page' : undefined}
      data-testid="sidebar-bot"
      className={cn(
        'flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-sidebar-accent',
        active && 'bg-sidebar-accent',
        collapsed && 'justify-center px-0',
      )}
    >
      <span className="relative">
        <BotAvatar
          name={bot.name}
          color={bot.avatarColor}
          shape={bot.avatarShape}
          status={bot.status}
          size="sm"
        />
        {collapsed && badge > 0 && (
          <span aria-hidden className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary" />
        )}
      </span>
      {!collapsed && (
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{bot.name}</span>
          {subtitle && <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>}
        </span>
      )}
      {!collapsed && badge > 0 && (
        <span
          className="ml-auto rounded-full bg-primary px-1.5 text-[10px] leading-4 font-semibold text-primary-foreground"
          data-testid="unread-badge"
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
      {badge > 0 && <span className="sr-only">{`${badge} unread`}</span>}
    </Link>
  );
}

function SidebarBots({ collapsed, pathname }: { collapsed: boolean; pathname: string }) {
  const { data: bots, isPending } = useBots();
  const { data: unread } = useUnreadCounts();
  const unreadOf = (bot: BotView) => (bot.dmThreadId ? (unread?.counts[bot.dmThreadId] ?? 0) : 0);
  const lead = bots?.find((b) => b.isLead);
  const others = (bots ?? []).filter((b) => !b.isLead && b.sidebarVisible);
  const isActive = (bot: BotView) =>
    pathname === `/bots/${bot.id}` || (bot.dmThreadId !== null && pathname === `/threads/${bot.dmThreadId}`);

  return (
    <>
      {/* Agent A is always pinned at the top (seeded with the team in F21; a placeholder until then). */}
      <Section title="Lead" collapsed={collapsed}>
        {lead ? (
          <BotLink
            bot={lead}
            subtitle={lead.role}
            collapsed={collapsed}
            active={isActive(lead)}
            unread={unreadOf(lead)}
          />
        ) : (
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
        )}
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
        <ul aria-label="Bots" className="space-y-0.5">
          {others.map((bot) => (
            <li key={bot.id}>
              <BotLink bot={bot} collapsed={collapsed} active={isActive(bot)} unread={unreadOf(bot)} />
            </li>
          ))}
        </ul>
        {!collapsed && !isPending && others.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground">No bots yet.</p>
        )}
      </Section>
    </>
  );
}

function SidebarGroups({ collapsed, pathname }: { collapsed: boolean; pathname: string }) {
  const { data: groups, isPending } = useGroups();
  const { data: unread } = useUnreadCounts();
  const [creating, setCreating] = useState(false);
  return (
    <Section
      title="Groups"
      collapsed={collapsed}
      action={
        <button
          type="button"
          aria-label="New group"
          onClick={() => setCreating(true)}
          className="rounded p-0.5 hover:bg-sidebar-accent hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      }
    >
      <ul aria-label="Groups" className="space-y-0.5">
        {(groups ?? []).map((g) => {
          const active = pathname === `/threads/${g.id}`;
          const badge = active ? 0 : (unread?.counts[g.id] ?? 0);
          return (
            <li key={g.id}>
              <Link
                href={`/threads/${g.id}`}
                title={collapsed ? g.title : undefined}
                aria-current={active ? 'page' : undefined}
                data-testid="sidebar-group"
                className={cn(
                  'flex h-8 items-center gap-2.5 rounded-md px-2 text-sm hover:bg-sidebar-accent',
                  active && 'bg-sidebar-accent font-medium',
                  collapsed && 'justify-center px-0',
                )}
              >
                <Hash className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                {!collapsed && <span className="min-w-0 flex-1 truncate">{g.title}</span>}
                {!collapsed && g.notifications === 'none' && (
                  <BellOff className="size-3.5 text-muted-foreground" aria-label="Muted" />
                )}
                {collapsed && <span className="sr-only">{g.title}</span>}
                {!collapsed && badge > 0 && (
                  <span className="rounded-full bg-primary px-1.5 text-[10px] leading-4 font-semibold text-primary-foreground">
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
                {badge > 0 && <span className="sr-only">{`${badge} unread`}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
      {!collapsed && !isPending && groups?.length === 0 && (
        <p className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
          <Users className="size-3.5" aria-hidden /> No group chats yet.
        </p>
      )}
      <NewGroupDialog open={creating} onClose={() => setCreating(false)} />
    </Section>
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
        <SidebarBots collapsed={collapsed} pathname={pathname} />

        <SidebarGroups collapsed={collapsed} pathname={pathname} />

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
