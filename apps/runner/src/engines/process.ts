import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { Readable } from 'node:stream';
import type { ExecHandle, ExecOptions } from '../containers/docker';
import { botHomeDir } from '../containers/home';

// Engine CLIs run as `docker exec` processes inside the bot's computer. Docker has no "kill this exec" API, so
// each one is started as its own session/process group (setsid) and records its pid; signal() kills the whole
// group with a second exec. Shared by the Claude (F08) and Codex (F09) adapters.

export const CONTAINER_HOME = '/home/bot';

export type EngineSpawn = {
  cmd: string[];
  /** Exec-time env (engine credentials). Never stored on the container. */
  env?: Record<string, string>;
  workdir: string;
  /** Container path fed to the process's stdin (the prompt). Default: /dev/null. */
  stdinFile?: string;
};

export type EngineProcess = {
  stdout: Readable;
  stderr: Readable;
  /** Exit code once the process ends. */
  wait(): Promise<number>;
  /**
   * Sends a signal to the whole process group (the CLI and every tool process it started). Still works after the
   * CLI exited, to reap stragglers: background jobs of non-interactive shells ignore SIGINT.
   */
  signal(sig: 'INT' | 'KILL'): Promise<void>;
  /** Forgets the process group (removes its pid file). Call once, after the last signal. */
  dispose(): Promise<void>;
};

export interface EngineLauncher {
  spawn(botId: string, spec: EngineSpawn): Promise<EngineProcess>;
  /** Writes a file under the bot's home (path relative to it, mode 600); returns its container path. */
  writeHomeFile(botId: string, relPath: string, content: string): string;
  /** Removes a file or folder under the bot's home (best effort). */
  removeHomeFile(botId: string, relPath: string): void;
  /** Whether a container path under /home/bot exists (checked on the host side). */
  homeFileExists(botId: string, containerPath: string): boolean;
}

type Exec = (botId: string, opts: ExecOptions) => Promise<ExecHandle>;

/** The `sh -c` wrapper: records the group leader's pid, then becomes the CLI with stdin from a file. */
const WRAPPER = 'p=$1; i=$2; shift 2; echo $$ > "$p" || exit 97; exec "$@" < "$i"';
const KILLER = 'kill -s "$1" -- "-$(cat "$2")" 2>/dev/null; true';

export function wrapCommand(spec: EngineSpawn, pidFile: string): string[] {
  return ['setsid', '-w', 'sh', '-c', WRAPPER, 'sh', pidFile, spec.stdinFile ?? '/dev/null', ...spec.cmd];
}

async function drain(h: ExecHandle): Promise<number> {
  h.stdout.resume();
  h.stderr.resume();
  return h.wait();
}

/** EngineLauncher over ContainerManager.exec (started on demand, keeps the computer awake while running). */
export class ContainerLauncher implements EngineLauncher {
  constructor(
    private readonly exec: Exec,
    private readonly botsDir: string,
  ) {}

  async spawn(botId: string, spec: EngineSpawn): Promise<EngineProcess> {
    const pidFile = `/tmp/agenta-proc-${randomUUID()}.pid`;
    const h = await this.exec(botId, {
      cmd: wrapCommand(spec, pidFile),
      env: spec.env,
      workdir: spec.workdir,
    });
    const run = async (script: string, ...args: string[]) =>
      drain(await this.exec(botId, { cmd: ['bash', '-c', script, 'bash', ...args] })).catch(() => -1);
    let disposed = false;
    return {
      stdout: h.stdout,
      stderr: h.stderr,
      wait: () => h.wait(),
      signal: async (sig) => {
        if (!disposed) await run(KILLER, sig, pidFile);
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await run('rm -f "$1"', pidFile);
      },
    };
  }

  private hostPath(botId: string, relPath: string): string {
    const rel = posix.normalize(relPath);
    if (rel.startsWith('..') || posix.isAbsolute(rel))
      throw new Error(`Path escapes the bot home: ${relPath}`);
    return join(botHomeDir(this.botsDir, botId), rel);
  }

  writeHomeFile(botId: string, relPath: string, content: string): string {
    const path = this.hostPath(botId, relPath);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { mode: 0o600 });
    return posix.join(CONTAINER_HOME, posix.normalize(relPath));
  }

  removeHomeFile(botId: string, relPath: string): void {
    rmSync(this.hostPath(botId, relPath), { recursive: true, force: true });
  }

  homeFileExists(botId: string, containerPath: string): boolean {
    const rel = posix.relative(CONTAINER_HOME, posix.normalize(containerPath));
    if (rel === '' || rel.startsWith('..') || posix.isAbsolute(rel)) return false;
    return existsSync(this.hostPath(botId, rel));
  }
}
