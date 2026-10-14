import type { Connector, Repos } from '@agenta/db';
import {
  type ConnectorPatch,
  type ConnectorType,
  type ConnectorView,
  connectorPatchSchema,
} from '@agenta/shared';
import type { SecretSource } from '../engines/secrets';

export class ConnectorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/** The .env.local variable holding each type's token. Google (F30) keeps OAuth tokens in data/secrets instead. */
const TOKEN_ENV: Record<ConnectorType, string | null> = { github: 'GITHUB_TOKEN', google: null };

/**
 * Connectors (F29): which bots may use which outside service. The GitHub token is read from .env.local per exec and
 * handed only to the bots the owner enabled, as GH_TOKEN; it is never stored in the DB, on a container or in a file.
 */
export class ConnectorService {
  constructor(private readonly opts: { repos: Repos; secrets: SecretSource }) {}

  /** Every connector; the GitHub one always exists (created disabled on first read). */
  list(): ConnectorView[] {
    const { connectors } = this.opts.repos;
    if (!connectors.list().some((c) => c.type === 'github'))
      connectors.create({ type: 'github', enabled: false });
    return connectors.list().map((c) => this.view(c));
  }

  update(id: string, input: ConnectorPatch): ConnectorView {
    const { repos } = this.opts;
    const patch = connectorPatchSchema.parse(input);
    if (!repos.connectors.get(id)) throw new ConnectorError('not_found', 'Connector not found', 404);
    const unknown = patch.botIds?.find((b) => !repos.bots.get(b));
    if (unknown) throw new ConnectorError('invalid_bot', `Bot ${unknown} not found`, 400);
    if (patch.enabled !== undefined) repos.connectors.update(id, { enabled: patch.enabled });
    if (patch.botIds) repos.connectors.setBots(id, patch.botIds);
    return this.view(repos.connectors.get(id)!);
  }

  /** Connector types this bot can use right now: enabled, the bot is allowed, and its token is set. */
  forBot(botId: string): ConnectorType[] {
    return this.opts.repos.connectors
      .listForBot(botId)
      .filter((c) => c.enabled && this.token(c.type) !== undefined)
      .map((c) => c.type);
  }

  /** Exec-time env for the bot's engine runs and terminals. */
  execEnv(botId: string): Record<string, string> {
    const token = this.forBot(botId).includes('github') ? this.token('github') : undefined;
    return token ? { GH_TOKEN: token } : {};
  }

  private token(type: ConnectorType): string | undefined {
    const name = TOKEN_ENV[type];
    return name ? this.opts.secrets.get(name) : undefined;
  }

  private view(c: Connector): ConnectorView {
    return {
      id: c.id,
      type: c.type,
      enabled: c.enabled,
      tokenEnv: TOKEN_ENV[c.type],
      tokenPresent: this.token(c.type) !== undefined,
      botIds: this.opts.repos.connectors.botIds(c.id),
      createdAt: c.createdAt,
    };
  }
}
