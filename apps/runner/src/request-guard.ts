import { apiError } from '@agenta/shared';
import type { FastifyInstance } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();

function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Why a request must be refused, or null. The API has no login (one owner, localhost), so two browser attacks matter:
 * - DNS rebinding: a site whose name resolves to 127.0.0.1 reads the API as same-origin. Its Host is that name, so the
 *   Host (or, behind the Next proxy, X-Forwarded-Host) must be a loopback name, the web origin's, or an allowed host.
 * - CSRF: any page can send a "simple" cross-site POST (no preflight; CORS only hides the response). Unsafe methods
 *   need an Origin matching the requested host, or, without one, no cross-site Sec-Fetch-Site. Local scripts and
 *   tests send neither header and pass. Safe methods stay open (OAuth callbacks arrive as cross-site navigations).
 */
export function guardVerdict(
  method: string,
  headers: IncomingHttpHeaders,
  allowed: { webOrigin: string; hosts: string[] },
): string | null {
  const host = first(headers['x-forwarded-host']) ?? first(headers.host);
  if (host) {
    const name = hostnameOf(host);
    const ok =
      name !== null &&
      (LOOPBACK.has(name) || name === new URL(allowed.webOrigin).hostname || allowed.hosts.includes(name));
    if (!ok) return `host ${host} is not allowed (add it to AGENTA_ALLOWED_HOSTS)`;
  }
  if (SAFE_METHODS.has(method)) return null;
  const origin = first(headers.origin);
  if (origin) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      // "null" or garbage: refused below.
    }
    const webHost = new URL(allowed.webOrigin).host;
    if (originHost !== host && originHost !== webHost) return `cross-origin ${method} from ${origin}`;
    return null;
  }
  const site = first(headers['sec-fetch-site']);
  if (site === 'cross-site' || site === 'same-site') return `${site} ${method} without an Origin`;
  return null;
}

/** Refuses foreign hosts and cross-site writes on every route (see guardVerdict). */
export function registerRequestGuard(
  app: FastifyInstance,
  allowed: { webOrigin: string; hosts: string[] },
): void {
  app.addHook('onRequest', async (req, reply) => {
    const why = guardVerdict(req.method, req.headers, allowed);
    if (!why) return;
    req.log.warn({ method: req.method, url: req.url, why }, 'request refused by the guard');
    return reply.code(403).send(apiError('forbidden_request', 'This request may not reach Agent A'));
  });
}
