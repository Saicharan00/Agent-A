import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

/** What one server's sign-in keeps on disk (git-ignored data/secrets, mode 0600): never in the DB or a response. */
type Stored = {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
};

/**
 * OAuth sign-in for remote MCP servers (PLAN F35), with the MCP SDK's client flow (discovery, dynamic client
 * registration, PKCE, refresh). The owner's browser is sent to the server's sign-in page; it comes back to
 * `<web origin>/api/mcp-oauth/callback`, which Next forwards to the runner. One JSON file per server.
 */
export class GatewayOAuth {
  /** Sign-in URLs handed out by the SDK during `auth()`, by server. */
  private readonly pendingUrls = new Map<string, URL>();

  constructor(
    private readonly dir: string,
    private readonly redirectUrl: string,
  ) {}

  hasTokens(serverId: string): boolean {
    return !!this.read(serverId).tokens?.access_token;
  }

  /** Token values, so the gateway can redact them from anything it shows. */
  secretValues(serverId: string): string[] {
    const t = this.read(serverId).tokens;
    return [t?.access_token, t?.refresh_token].filter((v): v is string => !!v);
  }

  /** The server a callback's `state` belongs to. */
  serverForState(state: string): string | undefined {
    if (!/^[a-f0-9]{32}$/.test(state)) return undefined;
    for (const serverId of this.knownServers()) if (this.read(serverId).state === state) return serverId;
    return undefined;
  }

  takeAuthorizationUrl(serverId: string): URL | undefined {
    const url = this.pendingUrls.get(serverId);
    this.pendingUrls.delete(serverId);
    return url;
  }

  signOut(serverId: string): void {
    rmSync(this.file(serverId), { force: true });
  }

  provider(serverId: string): OAuthClientProvider {
    const metadata: OAuthClientMetadata = {
      client_name: 'Agent A (local MCP gateway)',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
    return {
      redirectUrl: this.redirectUrl,
      clientMetadata: metadata,
      state: () => {
        const state = randomBytes(16).toString('hex');
        this.update(serverId, { state });
        return state;
      },
      clientInformation: () => this.read(serverId).client,
      saveClientInformation: (client) => this.update(serverId, { client }),
      tokens: () => this.read(serverId).tokens,
      saveTokens: (tokens) => this.update(serverId, { tokens, state: undefined, codeVerifier: undefined }),
      redirectToAuthorization: (url) => void this.pendingUrls.set(serverId, url),
      saveCodeVerifier: (codeVerifier) => this.update(serverId, { codeVerifier }),
      codeVerifier: () => {
        const v = this.read(serverId).codeVerifier;
        if (!v) throw new Error('No sign-in in progress for this server; press "Sign in" again');
        return v;
      },
      invalidateCredentials: (scope) => {
        if (scope === 'all') return this.signOut(serverId);
        const s = this.read(serverId);
        if (scope === 'client') delete s.client;
        if (scope === 'tokens') delete s.tokens;
        if (scope === 'verifier') delete s.codeVerifier;
        this.write(serverId, s);
      },
    };
  }

  private knownServers(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5));
    } catch {
      return [];
    }
  }

  private file(serverId: string): string {
    if (!/^mcs_[A-Za-z0-9]+$/.test(serverId)) throw new Error(`Invalid server id: ${serverId}`);
    return join(this.dir, `${serverId}.json`);
  }

  private read(serverId: string): Stored {
    try {
      return JSON.parse(readFileSync(this.file(serverId), 'utf8')) as Stored;
    } catch {
      return {};
    }
  }

  private update(serverId: string, patch: Partial<Stored>): void {
    this.write(serverId, { ...this.read(serverId), ...patch });
  }

  private write(serverId: string, data: Stored): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.file(serverId);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, file);
  }
}
