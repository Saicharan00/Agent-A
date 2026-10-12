import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findRepoRoot, loadRootEnv } from '../src/env';

describe('env loading', () => {
  afterEach(() => {
    delete process.env.AGENTA_TEST_A;
    delete process.env.AGENTA_TEST_B;
  });

  it('finds the workspace root from a nested dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'agenta-env-'));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    const nested = join(root, 'apps', 'x');
    mkdirSync(nested, { recursive: true });
    expect(findRepoRoot(nested)).toBe(root);
  });

  it('loads .env.local without overriding existing vars', () => {
    const root = mkdtempSync(join(tmpdir(), 'agenta-env-'));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    writeFileSync(join(root, '.env.local'), 'AGENTA_TEST_A=from-file\nAGENTA_TEST_B=from-file\n');
    process.env.AGENTA_TEST_B = 'from-shell';
    expect(loadRootEnv(root)).toBe(join(root, '.env.local'));
    expect(process.env.AGENTA_TEST_A).toBe('from-file');
    expect(process.env.AGENTA_TEST_B).toBe('from-shell');
  });

  it('returns undefined when there is no .env.local', () => {
    const root = mkdtempSync(join(tmpdir(), 'agenta-env-'));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    expect(loadRootEnv(root)).toBeUndefined();
  });
});
