'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { DoctorCheckRow, useDoctor } from '@/components/settings/doctor-section';
import { EnginesSection } from '@/components/settings/engines-section';
import { Button, buttonVariants } from '@/components/ui/button';
import { useBots } from '@/hooks/use-bots';
import { systemApi } from '@/lib/system';
import { toast } from '@/lib/toast';

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`onboarding-step-${n}`} className="space-y-3 rounded-xl border bg-card p-4">
      <h2 id={`onboarding-step-${n}`} className="flex items-center gap-2 text-base font-semibold">
        <span className="flex size-6 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** First-run wizard (F31): Docker and the bot image, engine sign-in, then create the team and say hello. */
export function OnboardingWizard() {
  const router = useRouter();
  const qc = useQueryClient();
  const doctor = useDoctor();
  const docker = doctor.data?.checks.filter(
    (c) => c.id === 'sandbox' || c.id === 'docker' || c.id === 'image',
  );
  const create = useMutation({
    mutationFn: systemApi.createTeam,
    onSuccess: (res) => {
      void qc.invalidateQueries();
      toast.success(`Team created: ${res.created.length} bots. Agent A is replying to your hello.`);
      router.push(`/threads/${res.leadThreadId}`);
    },
    onError: (err) => toast.error(`Could not create the team: ${err.message}`),
  });

  return (
    <div className="space-y-4" data-testid="onboarding">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Welcome! Let&apos;s set up your team</h2>
        <p className="text-sm text-muted-foreground">
          Three steps. Warnings don&apos;t block you: you can fix them later in Settings.
        </p>
      </div>
      <Step n={1} title="Docker and the bot computer image">
        <p className="text-sm text-muted-foreground">
          Every bot gets its own computer: a container built from the agenta-bot image.
        </p>
        {!docker && !doctor.error && <p className="text-sm text-muted-foreground">Checking…</p>}
        {doctor.error && <p className="text-sm text-destructive">Could not check: {doctor.error.message}</p>}
        {docker && (
          <ul className="divide-y rounded-lg border px-4" aria-label="Docker checks">
            {docker.map((c) => (
              <DoctorCheckRow key={c.id} check={c} />
            ))}
          </ul>
        )}
      </Step>
      <Step n={2} title="Sign the engines in">
        <EnginesSection />
      </Step>
      <Step n={3} title="Create the Agent A team">
        <p className="text-sm text-muted-foreground">
          Agent A (your lead) and six specialists, plus the Lead Room. Agent A gets a hello from you and
          introduces the team.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            <Users />
            {create.isPending ? 'Creating…' : 'Create the team'}
          </Button>
          <Link href="/bots/new" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            Skip: I&apos;ll make my own bot
          </Link>
        </div>
      </Step>
    </div>
  );
}

/** Shows the wizard instead of `children` while there are no bots. */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const bots = useBots();
  if (bots.data && bots.data.length === 0) return <OnboardingWizard />;
  return <>{children}</>;
}
