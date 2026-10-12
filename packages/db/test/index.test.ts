import { describe, expect, it } from 'vitest';
import { defaultDbPath } from '../src/index';

describe('db paths', () => {
  it('keeps the database under data/', () => {
    expect(defaultDbPath('/repo')).toBe('/repo/data/agenta.db');
  });
});
