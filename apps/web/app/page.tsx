import { Bot, KanbanSquare, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { HomeApprovals } from '@/components/approvals/home-approvals';
import { EmptyState } from '@/components/empty-state';
import { HomeGoals } from '@/components/goals/home-goals';
import { HomeActivity } from '@/components/notifications/home-activity';
import { Page, PageHeader } from '@/components/page-header';
import { buttonVariants } from '@/components/ui/button';

export default function HomePage() {
  return (
    <Page>
      <PageHeader
        title="Agent A"
        description="Your AI team, led by Agent A. Plan, delegate, review — and learn how a lead thinks."
      />
      <HomeApprovals />
      <HomeGoals />
      <HomeActivity />
      <div className="grid gap-4 md:grid-cols-3">
        <EmptyState
          icon={Sparkles}
          title="Talk to Agent A"
          description="Agent A plans work, hands it to specialist bots and reviews the results."
        />
        <EmptyState
          icon={Bot}
          title="Build your team"
          description="Each bot gets its own computer: terminal, browser and files."
          action={
            <Link href="/bots/new" className={buttonVariants({ size: 'sm' })}>
              New bot
            </Link>
          }
        />
        <EmptyState
          icon={KanbanSquare}
          title="Track the work"
          description="Tasks move from todo to review to done."
        />
      </div>
    </Page>
  );
}
