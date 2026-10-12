import { BOT_IMAGE, BOT_NETWORK, NOVNC_CONTAINER_PORT, type BotSettings } from '@agenta/shared';
import type { ContainerInfo, ContainerSpec } from './docker';

export const BOT_LABEL = 'agenta.bot';
export const PIDS_LIMIT = 512;
/** Hosts that must bypass the sandbox proxy from inside bot containers. */
const NO_PROXY_HOSTS = ['localhost', '127.0.0.1', '::1', 'host.docker.internal'];
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const;

export function containerName(slug: string, botId?: string): string {
  return botId ? `agenta-bot-${slug}-${botId.slice(-6).toLowerCase()}` : `agenta-bot-${slug}`;
}

/** Proxy env for bot containers, with host.docker.internal etc. always excluded from proxying. */
export function proxyEnv(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const name of PROXY_VARS) if (env[name]) out.push(`${name}=${env[name]}`);
  if (out.length === 0) return out;
  const noProxy = new Set(
    [env.NO_PROXY, env.no_proxy]
      .flatMap((v) => (v ?? '').split(','))
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const h of NO_PROXY_HOSTS) noProxy.add(h);
  const value = [...noProxy].join(',');
  out.push(`NO_PROXY=${value}`, `no_proxy=${value}`);
  return out;
}

export function buildContainerSpec(opts: {
  bot: { id: string; slug: string; settings: BotSettings };
  home: string;
  sharedDir: string;
  gateway: string;
  env: string[];
  image?: string;
  network?: string;
  nameSuffix?: boolean;
}): ContainerSpec {
  const { bot } = opts;
  return {
    name: containerName(bot.slug, opts.nameSuffix ? bot.id : undefined),
    image: opts.image ?? BOT_IMAGE,
    labels: { agenta: '1', [BOT_LABEL]: bot.id },
    env: [`AGENTA_BOT_ID=${bot.id}`, ...opts.env],
    binds: [`${opts.home}:/home/bot`, `${opts.sharedDir}:/shared`],
    network: opts.network ?? BOT_NETWORK,
    // Docker's `host-gateway` resolves to an unusable IPv6 address in the sandbox VM, so point
    // host.docker.internal at the bot network's gateway (the VM side of the bridge) instead.
    extraHosts: [`host.docker.internal:${opts.gateway}`],
    publishPort: NOVNC_CONTAINER_PORT,
    memoryBytes: Math.round(bot.settings.memoryMb * 1024 * 1024),
    nanoCpus: Math.round(bot.settings.cpus * 1e9),
    pidsLimit: PIDS_LIMIT,
    // The image runs as the non-root `bot` user and needs no capabilities (verified in F05).
    capAdd: [],
  };
}

/** Bot status implied by a container's Docker state. */
export function statusFromContainer(c: ContainerInfo | null): 'stopped' | 'starting' | 'running' | 'error' {
  if (!c) return 'stopped';
  switch (c.state) {
    case 'running':
      if (c.health === 'starting') return 'starting';
      if (c.health === 'unhealthy') return 'error';
      return 'running';
    case 'restarting':
      return 'starting';
    case 'dead':
      return 'error';
    default:
      return 'stopped';
  }
}
