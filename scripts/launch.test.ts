import { describe, expect, it } from 'vitest';
import { appUrl, needsBuild } from './launch';

describe('launch helpers', () => {
  it('rebuilds only when forced, missing, outside git, or built from another commit', () => {
    const base = { force: false, hasBuild: true, stamp: 'abc', rev: 'abc' };
    expect(needsBuild(base)).toBe(false);
    expect(needsBuild({ ...base, force: true })).toBe(true);
    expect(needsBuild({ ...base, hasBuild: false })).toBe(true);
    expect(needsBuild({ ...base, stamp: null })).toBe(true);
    expect(needsBuild({ ...base, rev: 'def' })).toBe(true);
    expect(needsBuild({ ...base, rev: null, stamp: null })).toBe(true);
  });

  it('prints localhost with the configured web port', () => {
    expect(appUrl({})).toBe('http://localhost:3000');
    expect(appUrl({ AGENTA_WEB_PORT: '4000' })).toBe('http://localhost:4000');
  });
});
