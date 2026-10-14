'use client';

import type { ApprovalDecideRequest } from '@agenta/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { approvalsApi } from '@/lib/approvals';
import { queryKeys } from '@/lib/query-keys';
import { toast } from '@/lib/toast';

/**
 * Pending approvals, kept fresh by the live `approval.changed` event; the slow poll lets requests that expired
 * (24 h, applied by the runner on read) drop off.
 */
export function usePendingApprovals() {
  return useQuery({
    queryKey: queryKeys.pendingApprovals,
    queryFn: () => approvalsApi.list('pending'),
    refetchInterval: 60_000,
  });
}

export function useDecideApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: ApprovalDecideRequest & { id: string }) => approvalsApi.decide(id, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.approvals }),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Something went wrong'),
  });
}
