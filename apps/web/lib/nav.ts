import type { LucideIcon } from 'lucide-react';
import {
  BarChart3,
  Bot,
  CalendarClock,
  GraduationCap,
  Home,
  KanbanSquare,
  Plus,
  Settings,
} from 'lucide-react';

export type NavItem = { href: string; label: string; icon: LucideIcon; keywords?: string };

/** Primary sidebar links (PLAN §2 "UI layout"). */
export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Home', icon: Home },
  { href: '/bots', label: 'Bots', icon: Bot, keywords: 'team teammates' },
  { href: '/tasks', label: 'Tasks', icon: KanbanSquare, keywords: 'board kanban' },
  { href: '/learn', label: 'Learn', icon: GraduationCap, keywords: 'lessons decisions mentor' },
  { href: '/schedules', label: 'Schedules', icon: CalendarClock, keywords: 'cron' },
  { href: '/usage', label: 'Usage', icon: BarChart3, keywords: 'limits' },
  { href: '/settings', label: 'Settings', icon: Settings, keywords: 'preferences' },
];

export const NEW_BOT_ITEM: NavItem = {
  href: '/bots/new',
  label: 'New bot',
  icon: Plus,
  keywords: 'create add',
};

/** Whether `href` is the active nav entry for `pathname` ("/" only matches exactly). */
export function isActivePath(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
