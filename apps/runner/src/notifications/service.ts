import type { Notification, Repos, Run } from '@agenta/db';
import {
  type LiveNotificationChanged,
  type NotificationCreateInput,
  type NotificationListQuery,
  type NotificationListResponse,
  type NotificationView,
  notificationListQuerySchema,
  notificationViewSchema,
  wantsDesktop,
} from '@agenta/shared';
import type { EventBus } from '../bus';

type NotifyRepos = Pick<Repos, 'notifications' | 'bots'>;

function toView(n: Notification): NotificationView {
  return notificationViewSchema.parse(n);
}

function publish(bus: EventBus | undefined, notification: NotificationView | null, desktop = false): void {
  const event: LiveNotificationChanged = { type: 'notification.changed', notification, desktop };
  bus?.publish('global', event);
}

/** Stores a notification for the owner's inbox and pushes it live (with the bot's desktop preference). */
export function notify(
  repos: NotifyRepos,
  bus: EventBus | undefined,
  input: NotificationCreateInput,
): NotificationView {
  const n = toView(repos.notifications.create({ ...input, title: input.title.slice(0, 300) }));
  const bot = n.botId ? repos.bots.get(n.botId) : undefined;
  publish(bus, n, wantsDesktop(n.kind, bot?.notifications ?? null));
  return n;
}

/** The last paragraph of a reply ends with a question mark (markdown emphasis and quotes aside). */
export function asksOwner(replyMd: string): boolean {
  const last =
    replyMd
      .trim()
      .split(/\n\s*\n/)
      .pop() ?? '';
  return /\?[*_`"')\]\s]*$/.test(last);
}

function excerpt(md: string, max = 280): string {
  const text = md.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A bot's turn ended: tell the owner when it was their turn (a message or a schedule) and they are not looking at
 * that thread, or when the bot asks them something. A failed scheduled run is always reported.
 * The owner "looks at" a thread while a browser tab is subscribed to its live channel.
 */
export function notifyRunFinished(repos: NotifyRepos, bus: EventBus, run: Run, replyMd?: string): void {
  if (run.status !== 'succeeded' && run.status !== 'failed') return;
  const name = repos.bots.get(run.botId)?.name ?? 'A bot';
  const link = run.threadId ? `/threads/${run.threadId}` : `/bots/${run.botId}`;
  const base = { botId: run.botId, link };
  if (run.trigger === 'schedule' && run.status === 'failed') {
    notify(repos, bus, {
      ...base,
      kind: 'schedule.failed',
      title: `Scheduled run failed: ${name}`,
      body: run.error ?? '',
    });
    return;
  }
  if (run.trigger !== 'user' && run.trigger !== 'schedule' && run.trigger !== 'mention') return;
  if (run.threadId && bus.listenerCount(`thread:${run.threadId}`) > 0) return;
  const question = !!replyMd && asksOwner(replyMd);
  // Bot-to-bot turns (mentions) only matter when they end with a question.
  if (run.trigger === 'mention' && !question) return;
  if (question) {
    notify(repos, bus, {
      ...base,
      kind: 'bot.question',
      title: `${name} has a question`,
      body: excerpt(
        replyMd
          .trim()
          .split(/\n\s*\n/)
          .pop() ?? '',
      ),
    });
  } else if (run.status === 'failed') {
    notify(repos, bus, {
      ...base,
      kind: 'run.failed',
      title: `${name}'s turn failed`,
      body: run.error ?? '',
    });
  } else {
    notify(repos, bus, {
      ...base,
      kind: 'run.finished',
      title: `${name} finished`,
      body: replyMd ? excerpt(replyMd) : '',
    });
  }
}

/** The owner's inbox (F27): list, mark read, mark all read. */
export class NotificationService {
  constructor(private readonly opts: { repos: NotifyRepos; bus: EventBus }) {}

  list(query: NotificationListQuery = {}): NotificationListResponse {
    const q = notificationListQuerySchema.parse(query);
    const { notifications } = this.opts.repos;
    return {
      items: notifications.list({ unreadOnly: q.unread === '1', limit: q.limit }).map(toView),
      unread: notifications.countUnread(),
    };
  }

  /** Idempotent: an already-read notification is returned as it is. */
  read(id: string): NotificationView | undefined {
    const { notifications } = this.opts.repos;
    const n = notifications.markRead(id);
    if (n) publish(this.opts.bus, null);
    const row = n ?? notifications.get(id);
    return row && toView(row);
  }

  readAll(): { marked: number } {
    const marked = this.opts.repos.notifications.markAllRead();
    if (marked) publish(this.opts.bus, null);
    return { marked };
  }
}
