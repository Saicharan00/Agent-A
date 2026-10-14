import type { Approval, Bot, Repos } from '@agenta/db';
import {
  APPROVAL_TTL_MS,
  type ApprovalDecideRequest,
  type ApprovalStatus,
  type ApprovalView,
  type LiveApprovalChanged,
  type RiskLevel,
  approvalViewSchema,
} from '@agenta/shared';
import type { EventBus } from '../bus';

type Log = { info(obj: object, msg?: string): void };

export class ApprovalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export type ApprovalServiceOptions = {
  repos: Repos;
  bus?: EventBus;
  log?: Log;
  /** Fake clock in tests (expiry). */
  now?: () => Date;
};

const toView = (a: Approval): ApprovalView => approvalViewSchema.parse(a);

/**
 * Approvals (PLAN F25): a bot asks with request_approval and polls check_approval; the owner decides in the inbox.
 * Pending requests expire 24 h after they were made; expiry is applied on every read, so no timer is needed.
 */
export class ApprovalService {
  private readonly now: () => Date;

  constructor(private readonly opts: ApprovalServiceOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  request(bot: Bot, input: { action: string; details: string; risk: RiskLevel }, runId: string | null) {
    const { repos } = this.opts;
    const a = repos.approvals.create({
      botId: bot.id,
      runId,
      action: input.action,
      detailsMd: input.details,
      risk: input.risk,
    });
    repos.notifications.create({
      kind: 'approval.requested',
      title: `${bot.name} asks to: ${input.action}`,
      body: `Risk: ${input.risk}. ${input.details}`.slice(0, 2_000),
      link: '/#approvals',
    });
    this.changed(a.id);
    return toView(a);
  }

  list(status?: ApprovalStatus): ApprovalView[] {
    this.expire();
    return this.opts.repos.approvals.list({ status }).map(toView);
  }

  get(id: string): ApprovalView {
    this.expire();
    const a = this.opts.repos.approvals.get(id);
    if (!a) throw new ApprovalError('not_found', `Approval ${id} not found`, 404);
    return toView(a);
  }

  decide(id: string, input: ApprovalDecideRequest): ApprovalView {
    const current = this.get(id);
    const a = this.opts.repos.approvals.decide(id, input);
    if (!a) throw new ApprovalError('already_decided', `Approval ${id} is already ${current.status}`, 409);
    // The note may be private context; log the decision only.
    this.opts.log?.info({ approvalId: id, botId: a.botId, status: a.status }, 'approval decided');
    this.changed(id);
    return toView(a);
  }

  /** Expires pending approvals older than 24 h. */
  expire(): number {
    const now = this.now();
    const n = this.opts.repos.approvals.expireOlderThan(
      new Date(now.getTime() - APPROVAL_TTL_MS).toISOString(),
      now.toISOString(),
    );
    if (n) this.changed('*');
    return n;
  }

  private changed(approvalId: string): void {
    const event: LiveApprovalChanged = { type: 'approval.changed', approvalId };
    this.opts.bus?.publish('global', event);
  }
}
