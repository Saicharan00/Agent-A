import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyTeamTemplate, loadTeamTemplate, parseSkill } from '../src/index';
import { useTestDb } from './helpers';

const TEAM_DIR = join(import.meta.dirname, '../../../templates/team');

describe('team template (F21)', () => {
  const t = useTestDb();
  const template = loadTeamTemplate(TEAM_DIR);

  it('loads 7 bots with instructions, one lead and known skills', () => {
    expect(template.bots.map((b) => b.slug)).toEqual([
      'agent-a',
      'architect',
      'ml-engineer',
      'data-engineer',
      'backend-engineer',
      'mlops-engineer',
      'qa-security',
    ]);
    expect(template.bots.filter((b) => b.isLead).map((b) => b.slug)).toEqual(['agent-a']);
    for (const b of template.bots) expect(b.instructions.length).toBeGreaterThan(200);
    expect([...template.skills.keys()].sort()).toEqual([
      'adr-writing',
      'carry-over-brief',
      'code-review-checklist',
      'design-review',
      'experiment-plan',
      'threat-model-lite',
    ]);
    const engine = Object.fromEntries(template.bots.map((b) => [b.slug, b.engine]));
    expect(engine).toMatchObject({
      'backend-engineer': 'codex',
      'data-engineer': 'codex',
      architect: 'claude',
    });
    expect(template.bots[0]!.instructions).toMatch(/Confidentiality rule/);
  });

  it('parses SKILL.md front matter', () => {
    expect(parseSkill('---\nname: x\ndescription: Does x.\n---\n\n# Body\n')).toEqual({
      name: 'x',
      description: 'Does x.',
      body: '# Body',
    });
    expect(parseSkill('no front matter')).toEqual({ body: 'no front matter' });
  });

  it('seeds 7 bots with DMs and the Lead Room, idempotently', () => {
    const first = applyTeamTemplate(t.repos, template, { restore: false });
    expect(first.created).toHaveLength(7);
    expect(first.leadRoomCreated).toBe(true);
    const bots = t.repos.bots.list();
    expect(bots).toHaveLength(7);
    const lead = t.repos.bots.getLead()!;
    expect(lead).toMatchObject({ slug: 'agent-a', engine: 'claude' });
    expect(lead.settings.skills).toContain('carry-over-brief');
    for (const b of bots) expect(t.repos.threads.findDm(b.id)).toBeDefined();
    expect(first.leadRoom).toMatchObject({ kind: 'group', title: 'Lead Room', moderatorBotId: lead.id });
    expect(t.repos.threads.listMembers(first.leadRoom.id)).toHaveLength(7);

    const again = applyTeamTemplate(t.repos, template, { restore: false });
    expect(again).toMatchObject({ created: [], restored: [], leadRoomCreated: false });
    expect(again.leadRoom.id).toBe(first.leadRoom.id);
    expect(t.repos.bots.list()).toHaveLength(7);
  });

  it('seeds the Daily plan and Weekly review schedules for Agent A, switched off, once', () => {
    applyTeamTemplate(t.repos, template, { restore: false });
    applyTeamTemplate(t.repos, template, { restore: true });
    const lead = t.repos.bots.getLead()!;
    expect(
      t.repos.schedules.list().map((s) => [s.name, s.botId, s.cron, s.timezone, s.enabled, s.nextRunAt]),
    ).toEqual([
      ['Daily plan', lead.id, '45 8 * * 1-5', 'America/New_York', false, null],
      ['Weekly review', lead.id, '45 16 * * 5', 'America/New_York', false, null],
    ]);
  });

  it('seed leaves edited bots alone; restore brings the defaults back and keeps the rest', () => {
    const { leadRoom } = applyTeamTemplate(t.repos, template, { restore: false });
    const arch = t.repos.bots.getBySlug('architect')!;
    t.repos.bots.update(arch.id, {
      instructions: 'custom',
      engine: 'codex',
      settings: { ...arch.settings, skills: [], cpus: 4 },
    });
    const qa = t.repos.bots.getBySlug('qa-security')!;
    t.repos.bots.archive(qa.id);
    t.repos.threads.removeMember(leadRoom.id, qa.id);
    const other = t.repos.bots.create({ name: 'Other lead', engine: 'mock', isLead: true });

    applyTeamTemplate(t.repos, template, { restore: false });
    expect(t.repos.bots.get(arch.id)!.instructions).toBe('custom');

    const res = applyTeamTemplate(t.repos, template, { restore: true });
    expect(res.created).toEqual([]);
    expect(res.restored).toHaveLength(7);
    const restored = t.repos.bots.get(arch.id)!;
    expect(restored.instructions).toMatch(/You are the Architect/);
    expect(restored.engine).toBe('codex'); // the owner's engine choice is kept
    expect(restored.settings).toMatchObject({
      cpus: 4,
      skills: ['adr-writing', 'design-review', 'threat-model-lite'],
    });
    expect(t.repos.bots.get(qa.id)!.archivedAt).toBeNull();
    expect(t.repos.threads.isMember(leadRoom.id, qa.id)).toBe(true);
    expect(t.repos.bots.get(other.id)!.isLead).toBe(false);
    expect(t.repos.bots.getLead()!.slug).toBe('agent-a');
  });
});
