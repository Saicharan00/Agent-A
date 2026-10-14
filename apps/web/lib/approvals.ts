// Approvals (F25): the owner's inbox of risky actions bots asked to take.
import { type ApprovalDecideRequest, type ApprovalStatus, approvalViewSchema } from '@agenta/shared';
import { z } from 'zod';
import { apiRequest } from './api';

export const approvalsApi = {
  list: (status?: ApprovalStatus) =>
    apiRequest('/approvals', z.array(approvalViewSchema), { query: { status } }),
  decide: (id: string, body: ApprovalDecideRequest) =>
    apiRequest(`/approvals/${encodeURIComponent(id)}/decide`, approvalViewSchema, { method: 'POST', body }),
};
