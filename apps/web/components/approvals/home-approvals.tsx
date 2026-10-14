'use client';

import { usePendingApprovals } from '@/hooks/use-approvals';
import { ApprovalList } from './approval-card';

/** Home: requests waiting for the owner. Hidden while there are none. */
export function HomeApprovals() {
  const { data } = usePendingApprovals();
  if (!data?.length) return null;
  return (
    <section id="approvals" className="space-y-2" aria-labelledby="home-approvals-title">
      <h2 id="home-approvals-title" className="text-sm font-semibold">
        Waiting for your approval ({data.length})
      </h2>
      <ApprovalList approvals={data} />
    </section>
  );
}
