import { PassThrough, type Duplex, type Readable } from 'node:stream';
import { NOVNC_CONTAINER_PORT } from '@agenta/shared';
import Docker from 'dockerode';

// The slice of Docker the container manager needs. `createDockerApi()` implements it with dockerode;
// unit tests use an in-memory fake (test/containers/fake-docker.ts).

export type ContainerState = 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead';
export type HealthState = 'starting' | 'healthy' | 'unhealthy' | 'none';

export type ContainerInfo = {
  id: string;
  name: string;
  state: ContainerState;
  health: HealthState;
  labels: Record<string, string>;
  /** Host port published for the given container port (127.0.0.1 binding), if any. */
  hostPort: number | null;
};

export type ContainerSpec = {
  name: string;
  image: string;
  labels: Record<string, string>;
  env: string[];
  binds: string[];
  network: string;
  extraHosts: string[];
  /** Container port published to 127.0.0.1:<random>. */
  publishPort: number;
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  capAdd: string[];
};

export type ExecOptions = {
  cmd: string[];
  /** Extra environment for this exec only (never stored on the container). */
  env?: Record<string, string>;
  workdir?: string;
  user?: string;
  stdin?: boolean;
};

export type ExecHandle = {
  stdout: Readable;
  stderr: Readable;
  /** Present when `stdin: true`. */
  stdin?: NodeJS.WritableStream;
  /** Resolves with the exit code once the process ends. */
  wait(): Promise<number>;
};

export type TtyHandle = {
  /** Bidirectional terminal stream (raw, not multiplexed). */
  stream: Duplex;
  resize(cols: number, rows: number): Promise<void>;
  wait(): Promise<number>;
};

export interface DockerApi {
  version(): Promise<string>;
  imageExists(ref: string): Promise<boolean>;
  /** Creates the bridge network if missing; returns its gateway IP. */
  ensureNetwork(name: string, labels: Record<string, string>): Promise<string>;
  list(labels: Record<string, string>): Promise<ContainerInfo[]>;
  inspect(id: string): Promise<ContainerInfo | null>;
  create(spec: ContainerSpec): Promise<string>;
  start(id: string): Promise<void>;
  stop(id: string, timeoutSec: number): Promise<void>;
  remove(id: string): Promise<void>;
  exec(id: string, opts: ExecOptions): Promise<ExecHandle>;
  execTty(id: string, opts: ExecOptions & { cols?: number; rows?: number }): Promise<TtyHandle>;
}

/** Docker API error status (404 not found, 409 conflict, 304 not modified…), if any. */
export function dockerStatus(err: unknown): number | undefined {
  const code = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === 'number' ? code : undefined;
}

function toEnvList(env: Record<string, string> | undefined): string[] | undefined {
  return env ? Object.entries(env).map(([k, v]) => `${k}=${v}`) : undefined;
}

function labelFilter(labels: Record<string, string>): string[] {
  return Object.entries(labels).map(([k, v]) => (v === '' ? k : `${k}=${v}`));
}

export function createDockerApi(docker: Docker = new Docker()): DockerApi {
  async function waitExit(exec: Docker.Exec): Promise<number> {
    for (;;) {
      const info = await exec.inspect();
      if (!info.Running) return info.ExitCode ?? -1;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  function toInfo(c: Docker.ContainerInspectInfo, port: number): ContainerInfo {
    const binding = c.NetworkSettings?.Ports?.[`${port}/tcp`]?.find((b) => b.HostIp === '127.0.0.1');
    return {
      id: c.Id,
      name: c.Name.replace(/^\//, ''),
      state: c.State.Status as ContainerState,
      health: (c.State.Health?.Status as HealthState | undefined) ?? 'none',
      labels: c.Config.Labels ?? {},
      hostPort: binding?.HostPort ? Number(binding.HostPort) : null,
    };
  }

  async function inspect(id: string): Promise<ContainerInfo | null> {
    try {
      const c = await docker.getContainer(id).inspect();
      // create() records the published port in a label so it can be read back for adopted containers.
      return toInfo(c, Number(c.Config.Labels?.['agenta.port'] ?? NOVNC_CONTAINER_PORT));
    } catch (err) {
      if (dockerStatus(err) === 404) return null;
      throw err;
    }
  }

  return {
    async version() {
      return (await docker.version()).Version;
    },

    async imageExists(ref) {
      try {
        await docker.getImage(ref).inspect();
        return true;
      } catch (err) {
        if (dockerStatus(err) === 404) return false;
        throw err;
      }
    },

    async ensureNetwork(name, labels) {
      const existing = await docker.listNetworks({ filters: { name: [name] } });
      const match = existing.find((n) => n.Name === name);
      const id =
        match?.Id ?? (await docker.createNetwork({ Name: name, Driver: 'bridge', Labels: labels })).id;
      const info = (await docker.getNetwork(id).inspect()) as { IPAM?: { Config?: { Gateway?: string }[] } };
      const gateway = info.IPAM?.Config?.find((c) => c.Gateway)?.Gateway;
      if (!gateway) throw new Error(`Network ${name} has no IPv4 gateway`);
      return gateway;
    },

    async list(labels) {
      const rows = await docker.listContainers({ all: true, filters: { label: labelFilter(labels) } });
      const infos = await Promise.all(rows.map((r) => inspect(r.Id)));
      return infos.filter((i): i is ContainerInfo => i !== null);
    },

    inspect,

    async create(spec) {
      const portKey = `${spec.publishPort}/tcp`;
      const c = await docker.createContainer({
        name: spec.name,
        Image: spec.image,
        Labels: { ...spec.labels, 'agenta.port': String(spec.publishPort) },
        Env: spec.env,
        ExposedPorts: { [portKey]: {} },
        HostConfig: {
          Binds: spec.binds,
          NetworkMode: spec.network,
          ExtraHosts: spec.extraHosts,
          PortBindings: { [portKey]: [{ HostIp: '127.0.0.1', HostPort: '' }] },
          Memory: spec.memoryBytes,
          MemorySwap: spec.memoryBytes,
          NanoCpus: spec.nanoCpus,
          PidsLimit: spec.pidsLimit,
          CapDrop: ['ALL'],
          CapAdd: spec.capAdd,
          SecurityOpt: ['no-new-privileges'],
          Privileged: false,
          RestartPolicy: { Name: 'no' },
        },
      });
      return c.id;
    },

    async start(id) {
      try {
        await docker.getContainer(id).start();
      } catch (err) {
        if (dockerStatus(err) !== 304) throw err; // 304: already running
      }
    },

    async stop(id, timeoutSec) {
      try {
        await docker.getContainer(id).stop({ t: timeoutSec });
      } catch (err) {
        const s = dockerStatus(err);
        if (s !== 304 && s !== 404) throw err; // already stopped / gone
      }
    },

    async remove(id) {
      try {
        await docker.getContainer(id).remove({ force: true, v: true });
      } catch (err) {
        if (dockerStatus(err) !== 404) throw err;
      }
    },

    async exec(id, opts) {
      const exec = await docker.getContainer(id).exec({
        Cmd: opts.cmd,
        Env: toEnvList(opts.env),
        WorkingDir: opts.workdir,
        User: opts.user,
        AttachStdout: true,
        AttachStderr: true,
        AttachStdin: opts.stdin ?? false,
        Tty: false,
      });
      const stream = await exec.start({ hijack: true, stdin: opts.stdin ?? false });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      docker.modem.demuxStream(stream, stdout, stderr);
      stream.on('end', () => {
        stdout.end();
        stderr.end();
      });
      stream.on('error', (err: Error) => {
        stdout.destroy(err);
        stderr.destroy(err);
      });
      return {
        stdout,
        stderr,
        stdin: opts.stdin ? stream : undefined,
        wait: async () => {
          if (!stream.readableEnded) await new Promise((r) => stream.once('end', r).once('close', r));
          return waitExit(exec);
        },
      };
    },

    async execTty(id, opts) {
      const exec = await docker.getContainer(id).exec({
        Cmd: opts.cmd,
        Env: toEnvList(opts.env),
        WorkingDir: opts.workdir,
        User: opts.user,
        AttachStdout: true,
        AttachStderr: true,
        AttachStdin: true,
        Tty: true,
      });
      const stream = (await exec.start({ hijack: true, stdin: true, Tty: true })) as Duplex;
      if (opts.cols && opts.rows) await exec.resize({ w: opts.cols, h: opts.rows }).catch(() => undefined);
      return {
        stream,
        resize: async (cols, rows) => {
          await exec.resize({ w: cols, h: rows });
        },
        wait: async () => {
          if (!stream.readableEnded) await new Promise((r) => stream.once('end', r).once('close', r));
          return waitExit(exec);
        },
      };
    },
  };
}
