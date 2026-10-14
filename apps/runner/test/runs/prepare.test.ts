import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot } from '@agenta/db';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContainerManager } from '../../src/containers/manager';
import { computerPreparer, renderHome } from '../../src/runs/prepare';

const bot = {
  id: 'bot_prep1',
  name: 'Builder',
  role: 'Backend engineer',
  instructions: 'Write tests first.',
  isLead: false,
  settings: { cpus: 2, memoryMb: 2048, idleTimeoutMin: 30, flags: {} },
} as Bot;

describe('computerPreparer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenta-prep-'));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function fakeContainers() {
    const calls: string[] = [];
    const containers = {
      ensureRunning: async (id: string) => {
        calls.push(`ensure ${id}`);
        return {};
      },
      acquire: (id: string) => {
        calls.push(`acquire ${id}`);
        return () => calls.push(`release ${id}`);
      },
    } as unknown as ContainerManager;
    return { calls, containers };
  }

  it('starts the computer, holds a lease and renders the instruction files for real engines', async () => {
    const { calls, containers } = fakeContainers();
    const release = await computerPreparer({ containers, botsDir: dir })(bot, 'claude');
    expect(calls).toEqual(['ensure bot_prep1', 'acquire bot_prep1']);
    const home = join(dir, 'bot_prep1', 'home');
    for (const f of ['CLAUDE.md', 'AGENTS.md']) {
      const text = readFileSync(join(home, f), 'utf8');
      expect(text).toContain('# Builder');
      expect(text).toContain('Write tests first.');
    }
    release();
    expect(calls.at(-1)).toBe('release bot_prep1');
  });

  it('leaves the computer alone for the mock engine', async () => {
    const { calls, containers } = fakeContainers();
    (await computerPreparer({ containers, botsDir: dir })(bot, 'mock'))();
    expect(calls).toEqual([]);
  });

  it('fails real-engine runs when Docker is disabled', async () => {
    await expect(computerPreparer({ botsDir: dir })(bot, 'codex')).rejects.toThrow(/Docker is disabled/);
  });

  it("renders the bot's team skills into ~/.claude/skills and AGENTS.md, keeping hand-made skills (F21)", () => {
    const skillsDir = join(import.meta.dirname, '../../../../templates/team/skills');
    const home = join(dir, 'home-skills');
    const skillsRoot = join(home, '.claude', 'skills');
    mkdirSync(join(skillsRoot, 'mine'), { recursive: true });
    writeFileSync(join(skillsRoot, 'mine', 'SKILL.md'), 'hand-made');
    const withSkills = (skills: string[]) => ({ ...bot, settings: { ...bot.settings, skills } }) as Bot;

    renderHome(home, withSkills(['adr-writing', 'design-review', 'no-such-skill']), skillsDir);
    expect(readFileSync(join(skillsRoot, 'adr-writing', 'SKILL.md'), 'utf8')).toMatch(
      /^---\nname: adr-writing/,
    );
    expect(existsSync(join(skillsRoot, 'design-review', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsRoot, 'no-such-skill'))).toBe(false);
    expect(readFileSync(join(home, 'AGENTS.md'), 'utf8')).toContain('### Skill: adr-writing');

    renderHome(home, withSkills(['design-review']), skillsDir);
    expect(existsSync(join(skillsRoot, 'adr-writing'))).toBe(false);
    expect(existsSync(join(skillsRoot, 'design-review', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(skillsRoot, 'mine', 'SKILL.md'), 'utf8')).toBe('hand-made');
    expect(readFileSync(join(home, 'CLAUDE.md'), 'utf8')).not.toContain('adr-writing');
  });
});
