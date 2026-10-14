import type { Metadata } from 'next';
import { MemoryPanel } from '@/components/memory/memory-panel';
import { Page, PageHeader } from '@/components/page-header';

export const metadata: Metadata = { title: 'Shared knowledge' };

export default function KnowledgePage() {
  return (
    <Page>
      <PageHeader
        title="Shared knowledge"
        description="What the whole team remembers. Every bot reads it before each run; files mirror to /shared/knowledge."
      />
      <MemoryPanel scope="shared" />
    </Page>
  );
}
