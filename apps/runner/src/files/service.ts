import type { Repos } from '@agenta/db';
import {
  type DirListing,
  type FileContent,
  type FileEntry,
  type FileRoot,
  type LiveFilesChanged,
  locateContainerPath,
} from '@agenta/shared';
import type { Logger } from 'pino';
import type { EventBus } from '../bus';
import { botHomeDir, bootstrapHome, ensureSharedLayout } from '../containers/home';
import type { GuardService } from '../guard/service';
import { FilesError, FileStore } from './store';

export type FilesServiceOptions = {
  repos: Repos;
  bus: EventBus;
  log: Logger;
  botsDir: string;
  sharedDir: string;
  /** Confidentiality guard (F24): checks uploads. */
  guard?: Pick<GuardService, 'guardUpload'>;
};

/**
 * Publishes a Files change: home changes on `bot:<id>`, team share changes on `global` (every bot sees them).
 */
export function publishFilesChanged(
  bus: EventBus,
  botId: string | null,
  root: FileRoot,
  path: string,
  change: LiveFilesChanged['change'],
): void {
  const event: LiveFilesChanged = { type: 'files.changed', botId, root, path, change };
  if (root === 'shared') bus.publish('global', event);
  else if (botId) bus.publish(`bot:${botId}`, event);
}

/** For engine `file.changed` events: the path as the bot saw it (`/home/bot/...`, `/shared/...`, or relative). */
export function publishEngineFileChange(
  bus: EventBus,
  botId: string,
  containerPath: string,
  change: 'created' | 'modified' | 'deleted',
): void {
  const loc = locateContainerPath(containerPath);
  if (loc) publishFilesChanged(bus, botId, loc.root, loc.path, change);
}

/** Files API (F15): a bot's home folder and the team share, read and written on the runner's disk. */
export class FilesService {
  constructor(private readonly opts: FilesServiceOptions) {
    ensureSharedLayout(opts.sharedDir);
  }

  private store(botId: string, root: FileRoot, write: boolean): FileStore {
    const bot = this.opts.repos.bots.get(botId);
    if (!bot) throw new FilesError('bot_not_found', `Bot ${botId} not found`, 404);
    if (write && bot.archivedAt) throw new FilesError('bot_archived', `${bot.name} is archived`, 409);
    if (root === 'shared') return new FileStore('shared', this.opts.sharedDir);
    const home = botHomeDir(this.opts.botsDir, botId);
    // A bot that never started has no home yet: give it the standard layout so there is something to browse.
    bootstrapHome(home);
    return new FileStore('home', home);
  }

  private changed(botId: string, root: FileRoot, path: string, change: LiveFilesChanged['change']) {
    publishFilesChanged(this.opts.bus, botId, root, path, change);
  }

  list(botId: string, root: FileRoot, path: string): DirListing {
    return this.store(botId, root, false).list(path);
  }

  read(botId: string, root: FileRoot, path: string): FileContent {
    return this.store(botId, root, false).read(path);
  }

  raw(botId: string, root: FileRoot, path: string): { real: string; size: number; name: string } {
    return this.store(botId, root, false).rawFile(path);
  }

  save(botId: string, root: FileRoot, path: string, content: string, expectedModifiedAt?: string): FileEntry {
    const entry = this.store(botId, root, true).writeText(path, content, expectedModifiedAt);
    this.opts.log.debug({ botId, root, path: entry.path }, 'file saved');
    this.changed(botId, root, entry.path, 'modified');
    return entry;
  }

  upload(
    botId: string,
    root: FileRoot,
    dir: string,
    name: string,
    data: Buffer,
    overwrite: boolean,
    allowFlagged = false,
  ): FileEntry {
    this.opts.guard?.guardUpload(data, allowFlagged, { botId, where: `files:${root}` });
    const rel = dir ? `${dir.replace(/\/+$/, '')}/${name}` : name;
    const entry = this.store(botId, root, true).writeBytes(rel, data, overwrite);
    this.opts.log.debug({ botId, root, path: entry.path, size: entry.size }, 'file uploaded');
    this.changed(botId, root, entry.path, 'created');
    return entry;
  }

  mkdir(botId: string, root: FileRoot, path: string): FileEntry {
    const entry = this.store(botId, root, true).mkdir(path);
    this.changed(botId, root, entry.path, 'created');
    return entry;
  }

  rename(botId: string, root: FileRoot, from: string, to: string): FileEntry {
    const entry = this.store(botId, root, true).rename(from, to);
    this.changed(botId, root, from, 'renamed');
    this.changed(botId, root, entry.path, 'renamed');
    return entry;
  }

  remove(botId: string, root: FileRoot, path: string): void {
    this.store(botId, root, true).remove(path);
    this.opts.log.debug({ botId, root, path }, 'file deleted');
    this.changed(botId, root, path, 'deleted');
  }
}
