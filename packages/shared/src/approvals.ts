// Approvals (F25): risky actions a bot asked the owner to approve, the owner's decision, and the live event.
import { z } from 'zod';
import { APPROVAL_STATUSES, RISK_LEVELS } from './enums';

/** A pending approval expires this long after it was requested. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export const approvalViewSchema = z.object({
  id: z.string(),
  botId: z.string(),
  runId: z.string().nullable(),
  action: z.string(),
  detailsMd: z.string(),
  risk: z.enum(RISK_LEVELS),
  status: z.enum(APPROVAL_STATUSES),
  note: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ApprovalView = z.infer<typeof approvalViewSchema>;

/** GET /api/approvals?status= */
export const approvalListQuerySchema = z.object({ status: z.enum(APPROVAL_STATUSES).optional() });

/** POST /api/approvals/:id/decide — the owner approves or denies, with an optional note for the bot. */
export const approvalDecideRequestSchema = z.object({
  status: z.enum(['approved', 'denied']),
  note: z.string().trim().max(2_000).optional(),
});
export type ApprovalDecideRequest = z.input<typeof approvalDecideRequestSchema>;

/** An approval was requested, decided or expired. Channel: `global`. */
export const liveApprovalChangedSchema = z.object({
  type: z.literal('approval.changed'),
  approvalId: z.string(),
});
export type LiveApprovalChanged = z.infer<typeof liveApprovalChangedSchema>;
