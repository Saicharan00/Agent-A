'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { botsApi, defaultBotForm } from '@/lib/bots';
import { queryKeys } from '@/lib/query-keys';
import { toast } from '@/lib/toast';
import { BotForm } from './bot-form';

export function NewBot() {
  const router = useRouter();
  const qc = useQueryClient();
  return (
    <BotForm
      initial={defaultBotForm()}
      submitLabel="Create bot"
      onCancel={() => router.push('/bots')}
      onSubmit={async (body) => {
        const bot = await botsApi.create(body);
        qc.setQueryData(queryKeys.bot(bot.id), bot);
        void qc.invalidateQueries({ queryKey: queryKeys.bots });
        toast.success(`${bot.name} created`);
        router.push(`/bots/${bot.id}`);
      }}
    />
  );
}
