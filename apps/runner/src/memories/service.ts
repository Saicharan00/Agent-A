import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Memory, type Repos, slugify } from '@agenta/db';
import {
  type LiveMemoryChanged,
  type MemoryCreateRequest,
  type MemoryScope,
  type MemoryUpdateRequest,
  type MemoryView,
  describeSecrets,
  findSecrets,
  memoryCreateRequestSchema,
  memoryViewSchema,
} from '@agenta/shared';
import type { EventBus } from '../bus';
import type { InstructionMemory } from '../engines/prompt';

type Log = { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };

/** Words of memory rendered into a bot's instruction files (PLAN F22: ~2,000). */
export const MEMORY_RENDER_WORDS = 2_000;

export class MemoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export type MemoryServiceOptions = {
  repos: Repos;
  bus?: EventBus;
  log?: Log;
  /** Host folder mounted at /shared: shared memories are mirrored to <sharedDir>/knowledge/<id>-<slug>.md. */
  sharedDir?: string;
};

export function toMemoryView(m: Memory): MemoryView {
  return memoryViewSchema.parse(m);
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * What goes under "## Memory" / "## Team knowledge": pinned memories first, then the most recently updated, until
 * `cap` words. The memory that crosses the cap is cut to the words left and nothing after it is added.
 */
export function selectForRender(memories: Memory[], cap = MEMORY_RENDER_WORDS): InstructionMemory[] {
  const ordered = [...memories].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
  );
  const out: InstructionMemory[] = [];
  let left = cap;
  for (const m of ordered) {
    const n = words(m.title) + words(m.contentMd);
    if (n <= left) {
      out.push({ title: m.title, contentMd: m.contentMd, scope: m.scope });
      left -= n;
      continue;
    }
    const room = left - words(m.title);
    if (room >= 20) {
      const cut = m.contentMd.split(/\s+/).filter(Boolean).slice(0, room).join(' ');
      out.push({ title: m.title, contentMd: `${cut} … (truncated)`, scope: m.scope });
    }
    break;
  }
  return out;
}

/**
 * Bot and shared memories (PLAN F22): the owner's API and the bots' save_memory tool both go through here, so every
 * save is checked for secrets, shared memories are mirrored to /shared/knowledge, and clients hear `memory.changed`.
 */
export class MemoryService {
  constructor(private readonly opts: MemoryServiceOptions) {}

  list(opts: { scope?: MemoryScope; botId?: string; q?: string } = {}): MemoryView[] {
    const { memories } = this.opts.repos;
    const rows = opts.q
      ? memories.search(opts.q, { scope: opts.scope, botId: opts.botId, limit: 100 })
      : memories.list({ scope: opts.scope, botId: opts.botId });
    return rows.map(toMemoryView);
  }

  /** Memories `botId` can see: its own and the team's, best match first. */
  search(botId: string, query: string, scope: MemoryScope | 'all', limit: number): Memory[] {
    return this.opts.repos.memories.search(query, {
      botId,
      scope: scope === 'all' ? undefined : scope,
      limit,
    });
  }

  create(input: MemoryCreateRequest, sourceRunId: string | null = null): MemoryView {
    const req = memoryCreateRequestSchema.parse(input);
    if (req.botId && !this.opts.repos.bots.get(req.botId))
      throw new MemoryError('bot_not_found', `Bot ${req.botId} not found`, 404);
    this.guard([req.title, req.contentMd, ...req.tags]);
    const m = this.opts.repos.memories.create({ ...req, botId: req.botId ?? null, sourceRunId });
    this.changed(m);
    this.opts.log?.info({ memoryId: m.id, scope: m.scope, botId: m.botId }, 'memory saved');
    return toMemoryView(m);
  }

  update(id: string, patch: MemoryUpdateRequest): MemoryView {
    const before = this.get(id);
    this.guard([patch.title ?? '', patch.contentMd ?? '', ...(patch.tags ?? [])]);
    const m = this.opts.repos.memories.update(id, patch) ?? before;
    this.changed(m);
    return toMemoryView(m);
  }

  delete(id: string): void {
    const m = this.get(id);
    this.opts.repos.memories.delete(id);
    this.changed(m, true);
  }

  /** The memory block rendered into `botId`'s instruction files before each run. */
  forRender(botId: string): InstructionMemory[] {
    const { memories } = this.opts.repos;
    return selectForRender([
      ...memories.list({ scope: 'bot', botId }),
      ...memories.list({ scope: 'shared' }),
    ]);
  }

  private get(id: string): Memory {
    const m = this.opts.repos.memories.get(id);
    if (!m) throw new MemoryError('not_found', `Memory ${id} not found`, 404);
    return m;
  }

  private guard(texts: string[]): void {
    const findings = findSecrets(texts.join('\n'));
    if (findings.length) {
      this.opts.log?.warn({ kinds: findings.map((f) => f.kind) }, 'memory rejected: secret');
      throw new MemoryError('secret_detected', describeSecrets(findings), 422);
    }
  }

  private changed(m: Memory, deleted = false): void {
    if (m.scope === 'shared') this.mirror(m, deleted);
    const event: LiveMemoryChanged = { type: 'memory.changed', memoryId: m.id, botId: m.botId };
    this.opts.bus?.publish('global', event);
  }

  /** One file per shared memory; a renamed memory's old file is replaced. Other files in knowledge/ are left alone. */
  private mirror(m: Memory, deleted: boolean): void {
    if (!this.opts.sharedDir) return;
    const dir = join(this.opts.sharedDir, 'knowledge');
    try {
      mkdirSync(dir, { recursive: true });
      for (const f of readdirSync(dir)) if (f.startsWith(`${m.id}-`)) rmSync(join(dir, f), { force: true });
      if (deleted) return;
      const path = join(dir, `${m.id}-${slugify(m.title) || 'memory'}.md`);
      const tags = m.tags.length ? `\n_Tags: ${m.tags.join(', ')}_\n` : '';
      writeFileSync(`${path}.tmp`, `# ${m.title}\n${tags}\n${m.contentMd.trim()}\n`);
      renameSync(`${path}.tmp`, path);
    } catch (err) {
      // The DB is the source of truth; a failed mirror must not fail the save.
      this.opts.log?.warn({ err, memoryId: m.id }, 'could not mirror shared memory');
    }
  }
}
