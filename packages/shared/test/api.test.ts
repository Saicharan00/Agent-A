import { describe, expect, it } from 'vitest';
import { apiError, apiErrorSchema, healthResponseSchema } from '../src/index';

describe('api schemas', () => {
  it('builds typed errors', () => {
    const err = apiError('not_found', 'Nope');
    expect(apiErrorSchema.parse(err)).toEqual({ error: { code: 'not_found', message: 'Nope' } });
  });

  it('validates health responses', () => {
    expect(healthResponseSchema.safeParse({ ok: true, version: '0.1.0', uptime: 1.5 }).success).toBe(true);
    expect(healthResponseSchema.safeParse({ ok: true, version: '0.1.0', uptime: -1 }).success).toBe(false);
  });
});
