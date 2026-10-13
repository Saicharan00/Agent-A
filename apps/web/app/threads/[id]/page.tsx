import type { Metadata } from 'next';
import { ThreadView } from '@/components/chat/thread-view';

export const metadata: Metadata = { title: 'Chat' };

export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Keyed by thread so switching conversations starts with a fresh composer and scroll position.
  return <ThreadView key={id} threadId={id} />;
}
