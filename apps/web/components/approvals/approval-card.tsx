'use client';

import type { ApprovalView, RiskLevel } from '@agenta/shared';
import { useState } from 'react';
import { BotAvatar } from '@/components/bot-avatar';
import { Markdown } from '@/components/markdown';
import { type PillTone, StatusPill } from '@/components/status-pill';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { useDecideApproval } from '@/hooks/use-approvals';
import { useBots } from '@/hooks/use-bots';
import { relativeTime } from '@/lib/bots';

const RISK_TONE: Record<RiskLevel, PillTone> = { low: 'neutral', medium: 'warn', high: 'error' };

/** One pending request: who asks, what, how risky, the details, and Approve / Deny with an optional note. */
export function ApprovalCard({ approval }: { approval: ApprovalView }) {
  const bots = useBots('include');
  const bot = bots.data?.find((b) => b.id === approval.botId);
  const decide = useDecideApproval();
  const [note, setNote] = useState('');
  const send = (status: 'approved' | 'denied') =>
    decide.mutate({ id: approval.id, status, ...(note.trim() ? { note } : {}) });

  return (
    <li
      className="space-y-2 rounded-lg border bg-card p-3"
      data-testid="approval-card"
      aria-label={`${bot?.name ?? 'A bot'} asks to: ${approval.action}`}
    >
      <div className="flex items-center gap-2">
        {bot && <BotAvatar name={bot.name} color={bot.avatarColor} shape={bot.avatarShape} size="sm" />}
        <span className="truncate text-sm font-medium">{bot?.name ?? (bots.data ? 'Deleted bot' : '…')}</span>
        <StatusPill tone={RISK_TONE[approval.risk]} className="ml-auto">
          {approval.risk} risk
        </StatusPill>
      </div>
      <p className="text-sm font-semibold">{approval.action}</p>
      {approval.detailsMd && <Markdown className="text-sm">{approval.detailsMd}</Markdown>}
      <p className="text-xs text-muted-foreground" title={new Date(approval.createdAt).toLocaleString()}>
        Asked {relativeTime(approval.createdAt)} · expires 24 h after asking
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note for the bot (optional)"
          aria-label="Note for the bot"
          maxLength={2000}
          className="h-8 min-w-40 flex-1"
        />
        <Button size="sm" onClick={() => send('approved')} disabled={decide.isPending}>
          Approve
        </Button>
        <Button size="sm" variant="outline" onClick={() => send('denied')} disabled={decide.isPending}>
          Deny
        </Button>
      </div>
    </li>
  );
}

export function ApprovalList({ approvals }: { approvals: ApprovalView[] }) {
  return (
    <ul className="space-y-2" aria-label="Pending approvals">
      {approvals.map((a) => (
        <ApprovalCard key={a.id} approval={a} />
      ))}
    </ul>
  );
}
