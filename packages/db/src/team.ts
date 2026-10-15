import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AVATAR_SHAPES, type BotSettings, ENGINES, botSettingsSchema, skillNameSchema } from '@agenta/shared';
import { z } from 'zod';
import type { Repos } from './repos';
import type { Bot, Thread } from './schema';

// The Agent A team template (F21): templates/team/{team.json, bots/<slug>.md, skills/<name>/SKILL.md}.
// `pnpm db:seed` creates it on a fresh DB; "Reset team to defaults" restores its instructions and skills.

const teamFileSchema = z.object({
  bots: z
    .array(
      z.object({
        slug: skillNameSchema,
        name: z.string().min(1).max(64),
        role: z.string().max(200),
        engine: z.enum(ENGINES),
        isLead: z.boolean().default(false),
        avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        avatarShape: z.enum(AVATAR_SHAPES),
        skills: z.array(skillNameSchema).default([]),
      }),
    )
    .min(1),
  group: z.object({ title: z.string().min(1).max(200), purpose: z.string().max(2000) }),
  /** Seeded disabled (F26); the owner switches them on in Schedules. */
  schedules: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        bot: skillNameSchema,
        cron: z.string(),
        prompt: z.string(),
      }),
    )
    .default([]),
});

export type TeamBotTemplate = z.infer<typeof teamFileSchema>['bots'][number] & { instructions: string };
export type TeamSkill = { name: string; description: string; body: string; dir: string };
export type TeamTemplate = {
  bots: TeamBotTemplate[];
  group: { title: string; purpose: string };
  schedules: z.infer<typeof teamFileSchema>['schedules'];
  skills: Map<string, TeamSkill>;
};

/** Splits a SKILL.md into its `name` / `description` front matter and the body. */
export function parseSkill(text: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { body: text.trim() };
  const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(m[1]!)?.[1]?.trim();
  return { name: field('name'), description: field('description'), body: text.slice(m[0].length).trim() };
}

/** Reads `<skillsDir>/<name>/SKILL.md` for every skill folder. Throws on a skill without name/description. */
export function loadSkills(skillsDir: string): Map<string, TeamSkill> {
  const skills = new Map<string, TeamSkill>();
  for (const name of existsSync(skillsDir) ? readdirSync(skillsDir) : []) {
    const skillDir = join(skillsDir, name);
    const path = join(skillDir, 'SKILL.md');
    if (!existsSync(path)) continue;
    const parsed = parseSkill(readFileSync(path, 'utf8'));
    if (parsed.name !== name || !parsed.description)
      throw new Error(`${path}: front matter needs name: ${name} and a description`);
    skills.set(name, { name, description: parsed.description, body: parsed.body, dir: skillDir });
  }
  return skills;
}

/** Reads and validates the template folder. Throws on a missing file, a bad skill or not exactly one lead. */
export function loadTeamTemplate(dir: string): TeamTemplate {
  const file = teamFileSchema.parse(JSON.parse(readFileSync(join(dir, 'team.json'), 'utf8')));
  const skills = loadSkills(join(dir, 'skills'));
  if (file.bots.filter((b) => b.isLead).length !== 1) throw new Error('team.json must have exactly one lead');
  const bots = file.bots.map((b) => {
    for (const s of b.skills) if (!skills.has(s)) throw new Error(`${b.slug}: unknown skill ${s}`);
    return { ...b, instructions: readFileSync(join(dir, 'bots', `${b.slug}.md`), 'utf8').trim() };
  });
  for (const s of file.schedules)
    if (!file.bots.some((b) => b.slug === s.bot)) throw new Error(`schedule ${s.name}: unknown bot ${s.bot}`);
  return { bots, group: file.group, skills, schedules: file.schedules };
}

export type TeamApplyResult = { created: Bot[]; restored: Bot[]; leadRoom: Thread; leadRoomCreated: boolean };

/**
 * Creates the template's missing bots and the Lead Room group (all template bots, moderated by the lead).
 * With `restore`, existing template bots (matched by slug, archived ones too) also get the template's role,
 * instructions, skills and lead flag back and are unarchived; names, engines, avatars, threads and history are
 * kept. Without it (the seed), existing bots are left alone.
 */
export function applyTeamTemplate(
  repos: Repos,
  template: TeamTemplate,
  opts: { restore: boolean; defaults?: Partial<BotSettings> },
): TeamApplyResult {
  const created: Bot[] = [];
  const restored: Bot[] = [];
  const team: Bot[] = [];
  for (const t of template.bots) {
    const existing = repos.bots.getBySlug(t.slug);
    if (!existing) {
      const bot = repos.bots.create({
        name: t.name,
        slug: t.slug,
        role: t.role,
        instructions: t.instructions,
        engine: t.engine,
        isLead: t.isLead,
        avatarColor: t.avatarColor,
        avatarShape: t.avatarShape,
        settings: botSettingsSchema.parse({ ...opts.defaults, skills: t.skills }),
      });
      created.push(bot);
      team.push(bot);
    } else if (opts.restore) {
      if (existing.archivedAt) repos.bots.unarchive(existing.id);
      const bot = repos.bots.update(existing.id, {
        role: t.role,
        instructions: t.instructions,
        isLead: t.isLead,
        settings: { ...existing.settings, skills: t.skills },
      })!;
      restored.push(bot);
      team.push(bot);
    } else team.push(existing);
  }

  // Bots made through the API get a DM thread; so do template bots (also restored ones that lost it).
  for (const b of team)
    if (!repos.threads.findDm(b.id))
      repos.threads.create({ kind: 'dm', title: b.name, memberBotIds: [b.id] });

  const lead = team[template.bots.findIndex((b) => b.isLead)]!;
  // One lead: a restored Agent A takes the role back from any other bot.
  if (opts.restore)
    for (const b of repos.bots.list({ includeArchived: true }))
      if (b.isLead && b.id !== lead.id) repos.bots.update(b.id, { isLead: false });

  let leadRoom = repos.threads.list({ kind: 'group' }).find((t) => t.title === template.group.title);
  const leadRoomCreated = !leadRoom;
  if (!leadRoom) {
    leadRoom = repos.threads.create({
      kind: 'group',
      title: template.group.title,
      purpose: template.group.purpose,
      moderatorBotId: lead.id,
      memberBotIds: team.map((b) => b.id),
    });
  } else if (opts.restore) {
    for (const b of team) repos.threads.addMember(leadRoom.id, b.id);
    leadRoom = repos.threads.update(leadRoom.id, {
      purpose: template.group.purpose,
      moderatorBotId: lead.id,
    })!;
  }

  // Missing template schedules are added switched off; existing ones (matched by name) are the owner's.
  const existing = new Set(repos.schedules.list().map((s) => s.name));
  for (const s of template.schedules) {
    const bot = team[template.bots.findIndex((b) => b.slug === s.bot)];
    if (bot && !existing.has(s.name))
      repos.schedules.create({ name: s.name, botId: bot.id, cron: s.cron, prompt: s.prompt, enabled: false });
  }
  return { created, restored, leadRoom, leadRoomCreated };
}
