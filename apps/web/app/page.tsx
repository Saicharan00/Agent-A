import { RunnerStatusBadge } from '@/components/runner-status';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-3xl font-semibold tracking-tight">Agent A</h1>
      <p className="text-muted-foreground">
        Your AI team, led by Agent A. Scaffold build — features coming soon.
      </p>
      <RunnerStatusBadge />
    </main>
  );
}
