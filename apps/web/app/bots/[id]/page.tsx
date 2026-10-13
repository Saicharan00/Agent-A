import type { Metadata } from 'next';
import { BotDetail } from '@/components/bots/bot-detail';

export const metadata: Metadata = { title: 'Bot' };

export default async function BotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BotDetail id={id} />;
}
