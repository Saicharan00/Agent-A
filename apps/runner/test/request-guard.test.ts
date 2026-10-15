import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { guardVerdict } from '../src/request-guard';
import { buildServer } from '../src/server';

const allowed = { webOrigin: 'http://localhost:3000', hosts: ['192.168.1.5'] };
const verdict = (method: string, headers: Record<string, string>) => guardVerdict(method, headers, allowed);

describe('request guard', () => {
  it('lets local scripts and the web app through', () => {
    expect(verdict('POST', { host: '127.0.0.1:3001' })).toBeNull();
    expect(
      verdict('POST', {
        host: '127.0.0.1:3001',
        'x-forwarded-host': 'localhost:3000',
        origin: 'http://localhost:3000',
        'sec-fetch-site': 'same-origin',
      }),
    ).toBeNull();
    expect(verdict('DELETE', { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' })).toBeNull();
    expect(verdict('POST', { host: '[::1]:3000', origin: 'http://localhost:3000' })).toBeNull();
  });

  it('refuses a foreign Host (DNS rebinding), even for reads', () => {
    expect(verdict('GET', { host: 'evil.example:3000' })).toMatch(/host evil.example:3000/);
    expect(
      verdict('GET', { host: '127.0.0.1:3001', 'x-forwarded-host': 'rebind.evil.example:3000' }),
    ).not.toBeNull();
  });

  it('accepts hosts from AGENTA_ALLOWED_HOSTS with their own origin', () => {
    expect(verdict('POST', { host: '192.168.1.5:3000', origin: 'http://192.168.1.5:3000' })).toBeNull();
  });

  it('refuses cross-site writes (CSRF)', () => {
    expect(verdict('POST', { host: 'localhost:3000', origin: 'http://evil.example' })).toMatch(
      /cross-origin POST/,
    );
    expect(verdict('POST', { host: 'localhost:3000', origin: 'http://localhost:8080' })).not.toBeNull();
    expect(verdict('POST', { host: 'localhost:3000', origin: 'null' })).not.toBeNull();
    expect(verdict('PUT', { host: 'localhost:3000', 'sec-fetch-site': 'cross-site' })).not.toBeNull();
    expect(verdict('POST', { host: 'localhost:3000', 'sec-fetch-site': 'same-site' })).not.toBeNull();
  });

  it('keeps cross-site navigations (OAuth callbacks) working', () => {
    expect(verdict('GET', { host: 'localhost:3000', 'sec-fetch-site': 'cross-site' })).toBeNull();
  });

  describe('on the server', () => {
    let app: FastifyInstance;
    beforeAll(async () => {
      app = await buildServer({ ...loadConfig({}), logLevel: 'silent', webOrigin: 'http://localhost:3000' });
    });
    afterAll(() => app.close());

    it('answers 403 with a typed error before any route runs', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/onboarding/team',
        headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({
        error: { code: 'forbidden_request', message: 'This request may not reach Agent A' },
      });
      expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    });
  });
});
