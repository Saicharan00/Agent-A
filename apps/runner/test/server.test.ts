import { healthResponseSchema } from '@agenta/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { buildServer } from '../src/server';

describe('runner server', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const };
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    app = await buildServer(config);
  });
  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health returns ok/version/uptime', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = healthResponseSchema.parse(res.json());
    expect(body.ok).toBe(true);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('allows CORS only for the web origin', async () => {
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');

    const denied = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://evil.example' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns typed errors for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});

describe('runner config', () => {
  it('defaults to 127.0.0.1:3001', () => {
    const c = loadConfig({});
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(3001);
    expect(c.engineOverride).toBeUndefined();
  });

  it('rejects invalid ports', () => {
    expect(() => loadConfig({ AGENTA_RUNNER_PORT: 'abc' })).toThrow();
  });
});
