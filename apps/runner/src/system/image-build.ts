import { spawn } from 'node:child_process';
import type { ImageBuildStatus } from '@agenta/shared';

const MAX_LINES = 400;

type Log = { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };

export type ImageBuilderOptions = {
  /** Repo root: `pnpm image:build` runs here. */
  cwd: string;
  log: Log;
  /** The build command (tests swap in a fake). */
  command?: [string, string[]];
};

/** Builds agenta-bot:latest from the UI (F31): one build at a time, output kept for the live log. */
export class ImageBuilder {
  private status: ImageBuildStatus = {
    state: 'idle',
    log: [],
    startedAt: null,
    finishedAt: null,
    exitCode: null,
  };
  private partial = '';

  constructor(private readonly opts: ImageBuilderOptions) {}

  current(): ImageBuildStatus {
    return { ...this.status, log: [...this.status.log] };
  }

  /** Starts a build; returns false if one is already running. */
  start(): boolean {
    if (this.status.state === 'running') return false;
    const [cmd, args] = this.opts.command ?? ['pnpm', ['image:build']];
    this.status = {
      state: 'running',
      log: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
    };
    this.partial = '';
    this.opts.log.info({ cmd, args }, 'bot image build started');
    const child = spawn(cmd, args, { cwd: this.opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (chunk: Buffer) => this.append(chunk.toString('utf8'));
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => this.finish(null, `Could not start the build: ${err.message}`));
    child.on('close', (code) => this.finish(code));
    return true;
  }

  private append(text: string): void {
    const parts = (this.partial + text).split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    this.status.log.push(...parts);
    if (this.status.log.length > MAX_LINES) this.status.log.splice(0, this.status.log.length - MAX_LINES);
  }

  private finish(code: number | null, message?: string): void {
    if (this.status.state !== 'running') return;
    if (this.partial) this.append('\n');
    if (message) this.append(`${message}\n`);
    const ok = code === 0;
    this.status = {
      ...this.status,
      state: ok ? 'succeeded' : 'failed',
      finishedAt: new Date().toISOString(),
      exitCode: code,
    };
    this.opts.log[ok ? 'info' : 'warn']({ exitCode: code }, 'bot image build finished');
  }
}
