import { PassThrough } from 'node:stream';
import { type EngineEvent, engineEventSchema } from '@agenta/shared';
import type { EngineLauncher, EngineProcess, EngineSpawn } from '../../src/engines/process';
import type { EngineAdapter, EngineRunInput } from '../../src/engines/types';

// A scripted stand-in for ContainerLauncher: no Docker, no CLI. Each spawn runs the next Behavior.

export type Behavior = (p: FakeProcess) => void;

export class FakeProcess implements EngineProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  disposed = false;
  private resolveExit!: (code: number) => void;
  private readonly exit = new Promise<number>((r) => (this.resolveExit = r));
  exited = false;
  onSignal?: (sig: 'INT' | 'KILL') => void;

  constructor(readonly spec: EngineSpawn) {}

  write(rows: unknown[] | string): void {
    this.stdout.write(typeof rows === 'string' ? rows : rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  end(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.stderr.end();
    this.resolveExit(code);
  }
  wait(): Promise<number> {
    return this.exit;
  }
  async signal(sig: 'INT' | 'KILL'): Promise<void> {
    this.signals.push(sig);
    this.onSignal?.(sig);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

export class FakeLauncher implements EngineLauncher {
  readonly procs: FakeProcess[] = [];
  readonly files = new Map<string, string>();
  readonly existing = new Set<string>();
  /** Files readable via readHomeFile, by container path. */
  readonly homeFiles = new Map<string, string>();
  constructor(private readonly behaviors: Behavior[]) {}

  async spawn(_botId: string, spec: EngineSpawn): Promise<EngineProcess> {
    const p = new FakeProcess(spec);
    this.procs.push(p);
    const behavior = this.behaviors[this.procs.length - 1];
    if (!behavior) throw new Error('container is not running');
    setImmediate(() => behavior(p));
    return p;
  }
  writeHomeFile(_botId: string, relPath: string, content: string): string {
    this.files.set(relPath, content);
    return `/home/bot/${relPath}`;
  }
  removeHomeFile(_botId: string, relPath: string): void {
    for (const k of [...this.files.keys()]) if (k.startsWith(relPath)) this.files.delete(k);
  }
  homeFileExists(_botId: string, containerPath: string): boolean {
    return this.existing.has(containerPath);
  }
  readHomeFile(_botId: string, containerPath: string): string | undefined {
    return this.homeFiles.get(containerPath);
  }
}

export const silent = { debug() {}, info() {}, warn() {} };

export async function collectEvents(
  engine: EngineAdapter,
  input: EngineRunInput,
  signal = new AbortController().signal,
): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const e of engine.run(input, signal)) events.push(engineEventSchema.parse(e));
  return events;
}

/** Writes JSONL text to stdout, optional stderr, then exits with `code`. */
export const replayText =
  (jsonl: string, code = 0, stderr = ''): Behavior =>
  (p) => {
    p.write(jsonl);
    if (stderr) p.stderr.write(stderr);
    p.end(code);
  };
