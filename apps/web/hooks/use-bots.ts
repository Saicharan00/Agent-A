'use client';

import type { BotView } from '@agenta/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { ApiClientError } from '@/lib/api';
import { botsApi } from '@/lib/bots';
import { queryKeys } from '@/lib/query-keys';
import { toast } from '@/lib/toast';

/** Bot lists stay fresh through the live `bots.changed` / `bot.status` events (lib/live-cache.ts). */
export function useBots(archived: 'exclude' | 'include' | 'only' = 'exclude') {
  return useQuery({ queryKey: queryKeys.botList(archived), queryFn: () => botsApi.list(archived) });
}

export function useBot(id: string, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.bot(id),
    enabled: opts.enabled ?? true,
    queryFn: () => botsApi.get(id),
    retry: (n, err) => !(err instanceof ApiClientError && err.status === 404) && n < 2,
  });
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong');

/** Archive / restore / duplicate / stop, with toasts and cache refresh. */
export function useBotActions() {
  const qc = useQueryClient();
  const router = useRouter();
  const refresh = (bot?: BotView) => {
    if (bot) qc.setQueryData(queryKeys.bot(bot.id), bot);
    void qc.invalidateQueries({ queryKey: queryKeys.bots });
  };
  const onError = (err: unknown) => void toast.error(errorText(err));

  const archive = useMutation({
    mutationFn: (bot: BotView) => botsApi.archive(bot.id),
    onSuccess: (bot) => {
      refresh(bot);
      toast.success(`${bot.name} archived`);
    },
    onError,
  });
  const restore = useMutation({
    mutationFn: (bot: BotView) => botsApi.restore(bot.id),
    onSuccess: (bot) => {
      refresh(bot);
      toast.success(`${bot.name} restored`);
    },
    onError,
  });
  const duplicate = useMutation({
    mutationFn: (bot: BotView) => botsApi.duplicate(bot.id),
    onSuccess: (bot) => {
      refresh(bot);
      toast.success(`Created ${bot.name}`);
      router.push(`/bots/${bot.id}`);
    },
    onError,
  });
  const stop = useMutation({
    mutationFn: (bot: BotView) => botsApi.stopComputer(bot.id),
    onSuccess: (_res, bot) => {
      refresh();
      toast.success(`${bot.name}'s computer stopped`);
    },
    onError,
  });
  return { archive, restore, duplicate, stop };
}
