'use client';

import type { BotView, ThreadView } from '@agenta/shared';
import { UserMinus, UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, type ReactNode, useState } from 'react';
import { BotAvatar } from '@/components/bot-avatar';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { useBots } from '@/hooks/use-bots';
import { useCreateGroup, useGroupMember, useUpdateThread } from '@/hooks/use-thread';

const DEFAULT_MODERATOR = 'Default (Agent A if a member, else the first member)';

function MemberRow({ bot, children }: { bot: BotView; children?: ReactNode }) {
  return (
    <li className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent/50">
      <BotAvatar
        name={bot.name}
        color={bot.avatarColor}
        shape={bot.avatarShape}
        status={bot.status}
        size="sm"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{bot.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          @{bot.slug}
          {bot.role ? ` · ${bot.role}` : ''}
        </span>
      </span>
      {children}
    </li>
  );
}

/** Title, purpose, members (at least one) and an optional moderator. Opens the new group when created. */
export function NewGroupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { data: bots } = useBots();
  const create = useCreateGroup();
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [moderator, setModerator] = useState('');
  const [error, setError] = useState<string | null>(null);

  function close() {
    setTitle('');
    setPurpose('');
    setMembers([]);
    setModerator('');
    setError(null);
    onClose();
  }

  function toggle(id: string, on: boolean) {
    setMembers((m) => (on ? [...m, id] : m.filter((x) => x !== id)));
    if (!on && moderator === id) setModerator('');
  }

  function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!title.trim()) return setError('Give the group a name');
    if (members.length === 0) return setError('Pick at least one bot');
    create.mutate(
      { title, purpose, memberBotIds: members, moderatorBotId: moderator || null },
      {
        onSuccess: (thread) => {
          close();
          router.push(`/threads/${thread.id}`);
        },
        onError: (err) => setError(err instanceof Error ? err.message : 'Could not create the group'),
      },
    );
  }

  const picked = (bots ?? []).filter((b) => members.includes(b.id));
  return (
    <Dialog
      open={open}
      onClose={close}
      title="New group chat"
      description="Talk to several bots at once. @mention bots to address them; other messages go to the moderator."
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" htmlFor="group-title">
          <Input id="group-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <Field label="Purpose" htmlFor="group-purpose" hint="Optional. Every bot sees it on each turn.">
          <Textarea
            id="group-purpose"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            className="min-h-16"
          />
        </Field>
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">Members</legend>
          <ul className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border p-1" aria-label="Members">
            {(bots ?? []).map((bot) => (
              <MemberRow key={bot.id} bot={bot}>
                <input
                  type="checkbox"
                  aria-label={`Add ${bot.name}`}
                  checked={members.includes(bot.id)}
                  onChange={(e) => toggle(bot.id, e.target.checked)}
                  className="size-4 accent-primary"
                />
              </MemberRow>
            ))}
            {bots?.length === 0 && <li className="px-2 py-1 text-xs text-muted-foreground">No bots yet.</li>}
          </ul>
        </fieldset>
        <Field label="Moderator" htmlFor="group-moderator" hint="Answers messages that mention nobody.">
          <Select id="group-moderator" value={moderator} onChange={(e) => setModerator(e.target.value)}>
            <option value="">{DEFAULT_MODERATOR}</option>
            {picked.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending}>
            Create group
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Members (add / remove), moderator and purpose of an open group. */
export function GroupMembersDialog({
  thread,
  open,
  onClose,
}: {
  thread: ThreadView;
  open: boolean;
  onClose: () => void;
}) {
  const { data: bots } = useBots();
  const member = useGroupMember(thread.id);
  const update = useUpdateThread(thread.id);
  const [purpose, setPurpose] = useState<string | null>(null);
  const memberIds = new Set(thread.members.map((m) => m.id));
  const others = (bots ?? []).filter((b) => !memberIds.has(b.id));
  const busy = member.isPending || update.isPending;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`#${thread.title}`}
      description="Members, moderator and purpose."
    >
      <div className="space-y-4">
        <section className="space-y-1.5">
          <h3 className="text-sm font-medium">Members ({thread.members.length})</h3>
          <ul
            className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border p-1"
            aria-label="Group members"
          >
            {thread.members.map((bot) => (
              <MemberRow key={bot.id} bot={bot}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${bot.name}`}
                  disabled={busy || thread.members.length <= 1}
                  onClick={() => member.mutate({ botId: bot.id, action: 'remove' })}
                >
                  <UserMinus aria-hidden />
                </Button>
              </MemberRow>
            ))}
          </ul>
        </section>
        {others.length > 0 && (
          <section className="space-y-1.5">
            <h3 className="text-sm font-medium">Add bots</h3>
            <ul
              className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border p-1"
              aria-label="Other bots"
            >
              {others.map((bot) => (
                <MemberRow key={bot.id} bot={bot}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Add ${bot.name}`}
                    disabled={busy}
                    onClick={() => member.mutate({ botId: bot.id, action: 'add' })}
                  >
                    <UserPlus aria-hidden />
                  </Button>
                </MemberRow>
              ))}
            </ul>
          </section>
        )}
        <Field label="Moderator" htmlFor="group-moderator-edit" hint="Answers messages that mention nobody.">
          <Select
            id="group-moderator-edit"
            value={thread.moderatorBotId ?? ''}
            disabled={busy}
            onChange={(e) => update.mutate({ moderatorBotId: e.target.value || null })}
          >
            <option value="">{DEFAULT_MODERATOR}</option>
            {thread.members.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Notifications"
          htmlFor="group-notifications"
          hint="What counts as unread in the sidebar."
        >
          <Select
            id="group-notifications"
            value={thread.notifications}
            disabled={busy}
            onChange={(e) => update.mutate({ notifications: e.target.value as ThreadView['notifications'] })}
          >
            <option value="all">All messages</option>
            <option value="mentions">Only @owner mentions and system notes</option>
            <option value="none">Nothing (muted)</option>
          </Select>
        </Field>
        <Field label="Purpose" htmlFor="group-purpose-edit">
          <Textarea
            id="group-purpose-edit"
            value={purpose ?? thread.purpose}
            onChange={(e) => setPurpose(e.target.value)}
            onBlur={() => {
              if (purpose !== null && purpose !== thread.purpose) update.mutate({ purpose });
              setPurpose(null);
            }}
            className="min-h-16"
          />
        </Field>
      </div>
    </Dialog>
  );
}
