/**
 * The container-runtime adapter boundary (AC-CISO-011).
 *
 * `ContainerRuntime` is the OS-independent port the core drives; concrete adapters translate
 * runtime-neutral specs into a specific CLI's argv and parse its output. The neutral verbs
 * (build / network / volume / run / stop / rm / exec) are docker-compatible, so `CliContainerRuntime`
 * builds that argv once; each subclass isolates only what is genuinely runtime-specific —
 * service bootstrap, `inspect` output shape, version/arch probing. Nothing above this boundary
 * imports a CLI name or a macOS API, which is what keeps Apple Container / macOS / launchd
 * specifics out of the core.
 */

import { spawnSync } from 'node:child_process';
import { NAMED_RESOURCE_PATTERN } from './schema.js';
import type {
  CapabilityReport,
  ContainerSpec,
  NetworkSpec,
  PortPublication,
  VolumeSpec,
} from './schema.js';

/** Result of one CLI invocation. `status` is null when the process was killed by a signal. */
export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs one CLI command. Injected everywhere so every adapter is unit-testable against a fake
 * runner with zero container engine present — the Apple-specific argv is asserted, not executed.
 */
export type CommandRunner = (command: string, args: readonly string[]) => CommandResult;

/** Build-time inputs for a standard OCI image build (host side, not a persisted contract). */
export interface ImageBuildSpec {
  /** Image tag to produce, e.g. `agentops-app:dev`. */
  image: string;
  /** Path to the Containerfile / Dockerfile. */
  containerfile: string;
  /** Build context directory. */
  contextDir: string;
  /** `--build-arg` values. */
  buildArgs?: Record<string, string>;
  /** Multi-stage `--target`. Absent = final stage. */
  target?: string;
}

/**
 * The port the OS-independent core drives. Methods are synchronous and throw `RuntimeCommandError`
 * on a non-zero exit so a failed lifecycle step fails closed rather than proceeding silently.
 */
export interface ContainerRuntime {
  readonly name: string;
  /** Non-mutating probe. Never throws — an absent CLI yields `available: false`, not an exception. */
  capability(): CapabilityReport;
  buildImage(spec: ImageBuildSpec): void;
  createNetwork(spec: NetworkSpec): void;
  removeNetwork(name: string): void;
  createVolume(spec: VolumeSpec): void;
  removeVolume(name: string): void;
  /** Starts a detached container; returns the runtime's container id/name. */
  runContainer(spec: ContainerSpec): string;
  /** Graceful stop with a drain timeout (parent #10: stop passes through DRAINING, never SIGKILL-first). */
  stopContainer(name: string, options?: { timeoutSeconds?: number }): void;
  removeContainer(name: string, options?: { force?: boolean }): void;
  /** Runs a command in a container and returns its result WITHOUT throwing — the exit code is data. */
  execInContainer(name: string, command: readonly string[]): CommandResult;
}

/** argv flags whose following `KEY=VALUE` token may carry a credential and must be redacted in errors/logs. */
const SECRET_VALUE_FLAGS = new Set(['--env', '-e', '--build-arg']);

/** Extracts the secret VALUES carried by `--env`/`--build-arg KEY=VALUE` tokens, for text redaction. */
export function extractSecretValues(args: readonly string[]): string[] {
  const secrets: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (SECRET_VALUE_FLAGS.has(args[i] as string) && i + 1 < args.length) {
      const next = args[i + 1] as string;
      const eq = next.indexOf('=');
      const value = eq >= 0 ? next.slice(eq + 1) : next;
      if (value !== '') secrets.push(value);
    }
  }
  return secrets;
}

/**
 * Redacts credential-bearing argv values so a failed command never leaks a secret through its argv.
 * `--env GITHUB_TOKEN=ghs-…` becomes `--env GITHUB_TOKEN=***`; a bare secret value becomes `***`.
 */
export function redactArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    out.push(arg);
    if (SECRET_VALUE_FLAGS.has(arg) && i + 1 < args.length) {
      const next = args[i + 1] as string;
      const eq = next.indexOf('=');
      out.push(eq >= 0 ? `${next.slice(0, eq)}=***` : '***');
      i += 1;
    }
  }
  return out;
}

/** Replaces every occurrence of each secret value in `text` with `***`. */
export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('***');
  }
  return out;
}

/**
 * A failed CLI invocation. Every field is safe to log: `args` and `result` are stored ALREADY
 * REDACTED — argv secrets (`--env`/`--build-arg` values) are masked, and those same values are
 * scrubbed from stdout/stderr — so neither the message nor `JSON.stringify(error)` can expose a
 * credential (parent #10 レッドライン: control/runner の資格情報を漏らさない). The raw, unredacted
 * argv/output never leave this constructor.
 */
export class RuntimeCommandError extends Error {
  readonly args: readonly string[];
  readonly result: CommandResult;

  constructor(readonly command: string, args: readonly string[], result: CommandResult) {
    const secrets = extractSecretValues(args);
    const redactedArgs = redactArgs(args);
    const redactedResult: CommandResult = {
      status: result.status,
      stdout: redactText(result.stdout, secrets),
      stderr: redactText(result.stderr, secrets),
    };
    super(
      `${command} ${redactedArgs.join(' ')} failed (status=${result.status ?? 'null'}): `
      + `${redactedResult.stdout}${redactedResult.stderr}`.trim(),
    );
    this.name = 'RuntimeCommandError';
    this.args = redactedArgs;
    this.result = redactedResult;
  }
}

/** The default runner: spawnSync with a generous buffer for image build / inspect output. */
export const spawnSyncRunner: CommandRunner = (command, args) => {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

/**
 * Renders one `PortPublication` into the docker/Apple-Container `--publish` value
 * `hostIp:hostPort:containerPort`. Shared because both CLIs accept the same form.
 */
export function renderPublishFlag(publish: PortPublication): string {
  return `${publish.hostIp}:${publish.hostPort}:${publish.containerPort}`;
}

/**
 * Renders one `VolumeMount` into the `--volume` value `name:mountPath[:ro]`. Enforces the named-volume
 * red line AT THE ARGV BOUNDARY — not just in the Zod schema — so even an untyped/JS caller that skips
 * `.parse()` cannot smuggle a host bind mount (e.g. a macOS home path) into the actual command.
 */
export function renderVolumeFlag(mount: { volume: string; mountPath: string; readOnly?: boolean }): string {
  if (!NAMED_RESOURCE_PATTERN.test(mount.volume)) {
    throw new Error(
      `refusing to mount volume source "${mount.volume}": only a named volume is allowed, never a host bind mount`,
    );
  }
  return mount.readOnly ? `${mount.volume}:${mount.mountPath}:ro` : `${mount.volume}:${mount.mountPath}`;
}

/**
 * Builds the runtime-neutral `run` argv (excluding the leading binary). Exported so tests can
 * assert the exact translation without a subclass, and so both adapters share one source of truth.
 */
export function buildRunArgs(spec: ContainerSpec): string[] {
  const args: string[] = ['run', '--detach', '--name', spec.name, '--network', spec.network];
  for (const publish of spec.publish) args.push('--publish', renderPublishFlag(publish));
  for (const mount of spec.volumes) args.push('--volume', renderVolumeFlag(mount));
  for (const [key, value] of Object.entries(spec.env)) args.push('--env', `${key}=${value}`);
  if (spec.workdir) args.push('--workdir', spec.workdir);
  args.push(spec.image);
  if (spec.command) args.push(...spec.command);
  return args;
}

/** Builds the runtime-neutral `build` argv (excluding the leading binary). */
export function buildBuildArgs(spec: ImageBuildSpec): string[] {
  const args: string[] = ['build', '--tag', spec.image, '--file', spec.containerfile];
  if (spec.target) args.push('--target', spec.target);
  for (const [key, value] of Object.entries(spec.buildArgs ?? {})) {
    args.push('--build-arg', `${key}=${value}`);
  }
  args.push(spec.contextDir);
  return args;
}

/**
 * The narrow set of subcommand verbs that genuinely differ between the docker-compatible CLIs.
 * Everything else (build / run / inspect / exec / container rm) is identical, so only these are
 * parameterised — declared in each adapter file, which is where the runtime-specific knowledge belongs.
 */
export interface CliDialect {
  /** Apple Container removes networks with `network delete`; docker with `network rm`. */
  networkRemoveVerb: 'delete' | 'rm';
  /** Apple Container removes volumes with `volume delete`; docker with `volume rm`. */
  volumeRemoveVerb: 'delete' | 'rm';
  /** Graceful-stop drain-timeout flag, or null when the CLI's `stop` takes no timeout. */
  stopTimeoutFlag: string | null;
}

/**
 * Shared base for CLI-driven runtimes. Implements the neutral verbs against `binary`; subclasses
 * supply only the runtime-specific probes, `inspect` parsing, and `dialect`. Keeping the argv here
 * (rather than duplicated per adapter) is safe precisely because the verbs are the neutral OCI CLI
 * surface — the *specifics* that differ are the abstract members below.
 */
export abstract class CliContainerRuntime implements ContainerRuntime {
  abstract readonly name: string;
  /** The CLI binary this adapter drives (`container`, `docker`, …). */
  protected abstract readonly binary: string;
  /** The runtime-specific verbs that diverge from the shared docker-compatible surface. */
  protected abstract readonly dialect: CliDialect;

  constructor(protected readonly run: CommandRunner = spawnSyncRunner) {}

  abstract capability(): CapabilityReport;

  /** Runs one CLI subcommand, throwing `RuntimeCommandError` on non-zero exit. */
  protected exec(args: readonly string[]): CommandResult {
    const result = this.run(this.binary, args);
    if (result.status !== 0) throw new RuntimeCommandError(this.binary, args, result);
    return result;
  }

  /** Runs one CLI subcommand without throwing — for probes that treat non-zero as "not ok". */
  protected tryExec(args: readonly string[]): CommandResult {
    return this.run(this.binary, args);
  }

  buildImage(spec: ImageBuildSpec): void {
    this.exec(buildBuildArgs(spec));
  }

  createNetwork(spec: NetworkSpec): void {
    this.exec(['network', 'create', spec.name]);
  }

  removeNetwork(name: string): void {
    this.exec(['network', this.dialect.networkRemoveVerb, name]);
  }

  createVolume(spec: VolumeSpec): void {
    this.exec(['volume', 'create', spec.name]);
  }

  removeVolume(name: string): void {
    this.exec(['volume', this.dialect.volumeRemoveVerb, name]);
  }

  runContainer(spec: ContainerSpec): string {
    return this.exec(buildRunArgs(spec)).stdout.trim();
  }

  stopContainer(name: string, options: { timeoutSeconds?: number } = {}): void {
    const args = ['stop'];
    if (typeof options.timeoutSeconds === 'number' && this.dialect.stopTimeoutFlag) {
      args.push(this.dialect.stopTimeoutFlag, String(options.timeoutSeconds));
    }
    args.push(name);
    this.exec(args);
  }

  removeContainer(name: string, options: { force?: boolean } = {}): void {
    const args = ['rm'];
    if (options.force) args.push('--force');
    args.push(name);
    this.exec(args);
  }

  execInContainer(name: string, command: readonly string[]): CommandResult {
    // Unlike the lifecycle verbs, exec is a query: its exit code is the answer, not necessarily an
    // error (e.g. `pg_isready` returns non-zero while starting; a grader's non-zero is a real result).
    // So it does NOT throw — the caller inspects `status` and decides.
    return this.tryExec(['exec', name, ...command]);
  }
}
