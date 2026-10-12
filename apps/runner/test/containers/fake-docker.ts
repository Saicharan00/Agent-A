import { PassThrough } from 'node:stream';
import type {
  ContainerInfo,
  ContainerSpec,
  DockerApi,
  ExecHandle,
  ExecOptions,
  HealthState,
  TtyHandle,
} from '../../src/containers/docker';

type FakeContainer = ContainerInfo & { spec: ContainerSpec };

/** In-memory DockerApi. Containers become healthy on start unless `startHealth` says otherwise. */
export class FakeDocker implements DockerApi {
  containers = new Map<string, FakeContainer>();
  execs: { id: string; opts: ExecOptions }[] = [];
  calls: string[] = [];
  imagePresent = true;
  startHealth: HealthState = 'healthy';
  down = false;
  /** Scripted exec result (default: echoes the command, exit 0). */
  execResult: (opts: ExecOptions) => { stdout: string; code: number } = (opts) => ({
    stdout: `ran ${opts.cmd.join(' ')}\n`,
    code: 0,
  });
  private seq = 0;
  private nextPort = 40000;

  private check(): void {
    if (this.down)
      throw Object.assign(new Error('connect ECONNREFUSED /var/run/docker.sock'), { code: 'ECONNREFUSED' });
  }

  async version() {
    this.check();
    return '29.0.0-fake';
  }
  async imageExists() {
    this.check();
    return this.imagePresent;
  }
  async ensureNetwork() {
    this.calls.push('ensureNetwork');
    return '172.30.0.1';
  }
  async list(labels: Record<string, string>) {
    this.check();
    return [...this.containers.values()]
      .filter((c) => Object.entries(labels).every(([k, v]) => (v === '' ? k in c.labels : c.labels[k] === v)))
      .map((c) => this.view(c));
  }
  async inspect(id: string) {
    this.check();
    const c = this.containers.get(id);
    return c ? this.view(c) : null;
  }
  async create(spec: ContainerSpec) {
    this.check();
    if ([...this.containers.values()].some((c) => c.name === spec.name)) {
      throw Object.assign(new Error('Conflict'), { statusCode: 409 });
    }
    const id = `ctr${++this.seq}`;
    this.containers.set(id, {
      id,
      name: spec.name,
      state: 'created',
      health: 'none',
      labels: spec.labels,
      hostPort: null,
      spec,
    });
    this.calls.push(`create:${spec.name}`);
    return id;
  }
  async start(id: string) {
    const c = this.must(id);
    c.state = 'running';
    c.health = this.startHealth;
    c.hostPort = this.nextPort++;
    this.calls.push(`start:${id}`);
  }
  async stop(id: string) {
    const c = this.containers.get(id);
    if (!c) return;
    c.state = 'exited';
    c.health = 'unhealthy';
    c.hostPort = null;
    this.calls.push(`stop:${id}`);
  }
  async remove(id: string) {
    this.containers.delete(id);
    this.calls.push(`remove:${id}`);
  }
  async exec(id: string, opts: ExecOptions): Promise<ExecHandle> {
    this.must(id);
    this.execs.push({ id, opts });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const result = this.execResult(opts);
    stdout.end(result.stdout);
    stderr.end();
    return { stdout, stderr, wait: async () => result.code };
  }
  async execTty(id: string, opts: ExecOptions): Promise<TtyHandle> {
    this.must(id);
    this.execs.push({ id, opts });
    const stream = new PassThrough();
    return { stream, resize: async () => undefined, wait: async () => 0 };
  }

  /** Simulates a container created outside the manager (e.g. before a runner restart). */
  addExternal(botId: string, state: ContainerInfo['state'] = 'running'): string {
    const id = `ext${++this.seq}`;
    this.containers.set(id, {
      id,
      name: `agenta-bot-ext-${this.seq}`,
      state,
      health: state === 'running' ? 'healthy' : 'none',
      labels: { agenta: '1', 'agenta.bot': botId },
      hostPort: state === 'running' ? this.nextPort++ : null,
      spec: {} as ContainerSpec,
    });
    return id;
  }

  private must(id: string): FakeContainer {
    this.check();
    const c = this.containers.get(id);
    if (!c) throw Object.assign(new Error('no such container'), { statusCode: 404 });
    return c;
  }

  private view(c: FakeContainer): ContainerInfo {
    const { spec: _spec, ...info } = c;
    return { ...info, health: c.state === 'running' ? c.health : 'none' };
  }
}
