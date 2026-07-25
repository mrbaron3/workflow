import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { assertContainerNeutralPath } from '../runtime/paths.js';
import { RunnerExecutionError } from './errors.js';

const NamedVolume = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const Mount = z.object({
  source: NamedVolume,
  target: z.string().min(1),
  readOnly: z.boolean(),
}).strict();
const OutboundDestination = z.object({
  host: z.string().trim().toLowerCase().regex(
    /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])$/,
  ),
  port: z.number().int().min(1).max(65_535),
}).strict();

export const RunnerStartupInput = z.object({
  workerId: z.string().trim().min(1).max(128),
  workspaceRoot: z.string().min(1),
  databaseUrl: z.string().url(),
  provider: z.enum(['codex', 'claude']),
  leaseDurationMs: z.number().int().min(5_000).max(60 * 60_000),
  heartbeatIntervalMs: z.number().int().min(500).max(10 * 60_000),
  reconciliationIntervalMs: z.number().int().min(250).max(10 * 60_000),
  maxAttempts: z.number().int().min(1).max(20),
  retryBaseMs: z.number().int().min(0).max(60 * 60_000),
  commandTimeoutMs: z.number().int().min(1_000).max(30 * 60_000),
  attemptTimeoutMs: z.number().int().min(5_000).max(24 * 60 * 60_000),
  mounts: z.array(Mount),
  publishedPorts: z.array(z.number().int().min(1).max(65_535)),
  outbound: z.array(OutboundDestination).min(1),
}).strict().refine(
  (value) => value.heartbeatIntervalMs * 2 < value.leaseDurationMs,
  'heartbeat interval must be less than half the lease duration',
).refine(
  (value) => value.commandTimeoutMs < value.attemptTimeoutMs,
  'command timeout must be less than the overall attempt timeout',
);
export type RunnerStartupInput = z.infer<typeof RunnerStartupInput>;

export interface RunnerCredentials {
  githubToken: string;
  provider: 'codex' | 'claude';
  providerToken: string;
}

export interface RunnerRuntimeBoundary {
  mountInfo: string;
  listeningTcpPorts: number[];
  visibleContainerSocketPaths: string[];
}

const CONTAINER_SOCKET_PATHS = [
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/run/containerd/containerd.sock',
  '/run/podman/podman.sock',
  '/run/host-services/container.sock',
] as const;

function listeningPorts(raw: string): number[] {
  const ports = new Set<number>();
  for (const line of raw.trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== '0A') continue; // Linux TCP_LISTEN
    const local = fields[1];
    const encodedPort = local?.split(':').at(-1);
    if (encodedPort && /^[0-9A-Fa-f]{4}$/.test(encodedPort)) {
      ports.add(Number.parseInt(encodedPort, 16));
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/** Inspect kernel-visible container state; no runtime socket is mounted or used. */
export function inspectRunnerRuntime(): RunnerRuntimeBoundary {
  const mountInfo = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  const tcp = fs.readFileSync('/proc/net/tcp', 'utf8');
  const tcp6 = fs.existsSync('/proc/net/tcp6')
    ? fs.readFileSync('/proc/net/tcp6', 'utf8')
    : '';
  return {
    mountInfo,
    listeningTcpPorts: [...new Set([
      ...listeningPorts(tcp),
      ...listeningPorts(tcp6),
    ])].sort((a, b) => a - b),
    visibleContainerSocketPaths: CONTAINER_SOCKET_PATHS.filter((candidate) => {
      try {
        return fs.statSync(candidate).isSocket();
      } catch {
        return false;
      }
    }),
  };
}

interface ObservedMount {
  majorMinor: string;
  root: string;
  target: string;
  options: string[];
  fsType: string;
  source: string;
  raw: string;
}

function decodeMountField(value: string): string {
  return value.replaceAll(/\\(040|011|012|134)/g, (escaped, code: string) => ({
    '040': ' ',
    '011': '\t',
    '012': '\n',
    '134': '\\',
  })[code] ?? escaped);
}

function observedMount(line: string): ObservedMount {
  const fields = line.split(' ');
  const separator = fields.indexOf('-');
  if (separator < 6 || fields.length < separator + 3) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      `malformed kernel mount entry: ${line}`,
      false,
    );
  }
  return {
    majorMinor: fields[2] ?? '',
    root: decodeMountField(fields[3] ?? ''),
    target: decodeMountField(fields[4] ?? ''),
    options: (fields[5] ?? '').split(','),
    fsType: fields[separator + 1] ?? '',
    source: decodeMountField(fields[separator + 2] ?? ''),
    raw: line,
  };
}

function platformVirtualMount(mount: ObservedMount): boolean {
  const { target } = mount;
  return (target === '/home/agentops' && mount.fsType === 'tmpfs')
    || target === '/tmp'
    || target === '/run'
    || target === '/etc/hosts'
    || target === '/etc/hostname'
    || target === '/etc/resolv.conf'
    || target === '/proc'
    || target.startsWith('/proc/')
    || target === '/sys'
    || target.startsWith('/sys/')
    || target === '/dev'
    || target.startsWith('/dev/');
}

function validateRuntimeBoundary(boundary: RunnerRuntimeBoundary): void {
  const mounts = boundary.mountInfo.split('\n').filter(Boolean).map(observedMount);
  const workspace = mounts.find((mount) => mount.target === '/workspace');
  const root = mounts.find((mount) => mount.target === '/');
  if (!workspace || !workspace.options.includes('rw')) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'kernel mount table does not show a writable /workspace volume',
      false,
    );
  }
  if (!root || !root.options.includes('ro')) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'runner root filesystem must be kernel-mounted read-only',
      false,
    );
  }
  const namedVolumeRoot = workspace?.root === '/'
    ? workspace.majorMinor !== root.majorMinor
    : /^\/var\/lib\/(?:docker\/volumes|containers\/storage\/volumes)\/[^/]+\/_data$/
      .test(workspace?.root ?? '');
  if (
    !workspace
    || !['ext4', 'xfs', 'btrfs'].includes(workspace.fsType)
    || !workspace.source.startsWith('/dev/')
    || !namedVolumeRoot
  ) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'kernel /workspace mount is not an observed private block-backed named volume',
      false,
    );
  }
  for (const mount of mounts) {
    if (
      mount.options.includes('rw')
      && mount.target !== '/'
      && mount.target !== '/workspace'
      && !platformVirtualMount(mount)
    ) {
      throw new RunnerExecutionError(
        'startup_isolation_failure',
        `unexpected writable kernel mount: ${mount.target}`,
        false,
      );
    }
  }
  for (const marker of [
    '/Users/',
    '/Company/Development/',
    'docker.sock',
    'container.sock',
    '/run/host-services',
    'SSH_AUTH_SOCK',
  ]) {
    if (boundary.mountInfo.includes(marker)) {
      throw new RunnerExecutionError(
        'startup_isolation_failure',
        `kernel mount table contains forbidden host/socket marker: ${marker}`,
        false,
      );
    }
  }
  if (boundary.listeningTcpPorts.length !== 0) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      `runner must start without listening TCP sockets: ${boundary.listeningTcpPorts.join(',')}`,
      false,
    );
  }
  if (boundary.visibleContainerSocketPaths.length !== 0) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      `runner can see container management sockets: ${boundary.visibleContainerSocketPaths.join(',')}`,
      false,
    );
  }
}

const FORBIDDEN_ENV_KEYS = [
  'SSH_AUTH_SOCK',
  'DOCKER_HOST',
  'CONTAINER_HOST',
  'CONTAINER_SOCK',
  'AGENTOPS_CONTROL_TOKEN',
  'AGENTOPS_WEBHOOK_SECRET',
  'AGENTOPS_GITHUB_WEBHOOK_SECRET',
  'AGENTOPS_CONTROL_DATABASE_URL',
] as const;

const PROVIDER_TOKEN_KEYS = {
  codex: 'OPENAI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
} as const;

const PROVIDER_DESTINATIONS = {
  codex: 'api.openai.com:443',
  claude: 'api.anthropic.com:443',
} as const;

function parseJson(name: string, raw: string | undefined): unknown {
  if (raw === undefined || raw.trim() === '') {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      `${name} is required`,
      false,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      `${name} is not valid JSON`,
      false,
      null,
      { cause: error },
    );
  }
}

function integerEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      `${key} must be an integer`,
      false,
    );
  }
  return value;
}

function requiredSecret(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      `${key} is required for the isolated runner`,
      false,
    );
  }
  return value;
}

function destinationKey(destination: z.infer<typeof OutboundDestination>): string {
  return `${destination.host}:${destination.port}`;
}

/**
 * Validates the runner's complete startup boundary before a DB connection,
 * provider, GitHub credential, or job is used.
 */
export function loadRunnerStartup(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  runtimeBoundary?: RunnerRuntimeBoundary,
): {
  config: RunnerStartupInput;
  credentials: RunnerCredentials;
  runtimeBoundary: RunnerRuntimeBoundary | null;
} {
  for (const key of FORBIDDEN_ENV_KEYS) {
    if (env[key]) {
      throw new RunnerExecutionError(
        'startup_isolation_failure',
        `forbidden runner environment variable is present: ${key}`,
        false,
      );
    }
  }
  const home = assertContainerNeutralPath(env.HOME ?? '', 'HOME');
  if (home !== '/home/agentops') {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      `runner HOME must be /home/agentops, got ${home}`,
      false,
    );
  }
  const safeCwd = assertContainerNeutralPath(cwd, 'runner cwd');
  if (safeCwd !== '/app' && !safeCwd.startsWith('/app/')) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      `runner cwd must be inside /app, got ${safeCwd}`,
      false,
    );
  }

  const provider = z.enum(['codex', 'claude']).parse(
    env.AGENTOPS_RUNNER_PROVIDER,
  );
  const selectedProviderKey = PROVIDER_TOKEN_KEYS[provider];
  for (const [candidate, key] of Object.entries(PROVIDER_TOKEN_KEYS)) {
    if (candidate !== provider && env[key]) {
      throw new RunnerExecutionError(
        'startup_isolation_failure',
        `credential for unselected provider is present: ${key}`,
        false,
      );
    }
  }
  const workspaceRoot = assertContainerNeutralPath(
    env.AGENTOPS_WORKSPACE_ROOT ?? '/workspace',
    'AGENTOPS_WORKSPACE_ROOT',
  );
  if (workspaceRoot !== '/workspace') {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      `runner workspace root must be the private /workspace volume, got ${workspaceRoot}`,
      false,
    );
  }

  const databaseUrl = requiredSecret(env, 'AGENTOPS_RUNNER_DATABASE_URL');
  const database = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'runner database URL must use postgresql',
      false,
    );
  }
  const mounts = z.array(Mount).parse(
    parseJson('AGENTOPS_RUNNER_MOUNTS_JSON', env.AGENTOPS_RUNNER_MOUNTS_JSON),
  );
  const publishedPorts = z.array(z.number().int().min(1).max(65_535)).parse(
    parseJson(
      'AGENTOPS_RUNNER_PUBLISHED_PORTS_JSON',
      env.AGENTOPS_RUNNER_PUBLISHED_PORTS_JSON,
    ),
  );
  const outbound = z.array(OutboundDestination).min(1).parse(
    parseJson('AGENTOPS_RUNNER_OUTBOUND_JSON', env.AGENTOPS_RUNNER_OUTBOUND_JSON),
  );
  const config = RunnerStartupInput.parse({
    workerId: env.AGENTOPS_RUNNER_WORKER_ID,
    workspaceRoot,
    databaseUrl,
    provider,
    leaseDurationMs: integerEnv(env, 'AGENTOPS_RUNNER_LEASE_MS', 60_000),
    heartbeatIntervalMs: integerEnv(env, 'AGENTOPS_RUNNER_HEARTBEAT_MS', 15_000),
    reconciliationIntervalMs: integerEnv(
      env,
      'AGENTOPS_RUNNER_RECONCILE_MS',
      5_000,
    ),
    maxAttempts: integerEnv(env, 'AGENTOPS_RUNNER_MAX_ATTEMPTS', 3),
    retryBaseMs: integerEnv(env, 'AGENTOPS_RUNNER_RETRY_BASE_MS', 5_000),
    commandTimeoutMs: integerEnv(
      env,
      'AGENTOPS_RUNNER_COMMAND_TIMEOUT_MS',
      120_000,
    ),
    attemptTimeoutMs: integerEnv(
      env,
      'AGENTOPS_RUNNER_ATTEMPT_TIMEOUT_MS',
      4 * 60 * 60_000,
    ),
    mounts,
    publishedPorts,
    outbound,
  });

  if (
    config.mounts.length !== 1
    || config.mounts[0]?.target !== '/workspace'
    || config.mounts[0].readOnly
  ) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'runner must have exactly one writable named volume mounted at /workspace',
      false,
    );
  }
  if (config.publishedPorts.length !== 0) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'runner must not publish any host port',
      false,
    );
  }
  const allowed = new Set(config.outbound.map(destinationKey));
  const databaseHost = database.hostname.toLowerCase();
  const databasePort = Number(database.port || 5432);
  if (!allowed.has(`${databaseHost}:${databasePort}`)) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      `database destination ${databaseHost}:${databasePort} is not in the outbound allowlist`,
      false,
    );
  }
  const required = new Set([
    `${databaseHost}:${databasePort}`,
    'github.com:443',
    'api.github.com:443',
    PROVIDER_DESTINATIONS[provider],
  ]);
  if (
    required.size !== allowed.size
    || ![...required].every((destination) => allowed.has(destination))
  ) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      `runner outbound allowlist must exactly match the database, GitHub, and ${provider} destinations`,
      false,
    );
  }
  if (path.resolve(config.workspaceRoot) !== config.workspaceRoot) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'workspace root must be normalized',
      false,
    );
  }
  if (runtimeBoundary) validateRuntimeBoundary(runtimeBoundary);

  return {
    config,
    runtimeBoundary: runtimeBoundary ?? null,
    credentials: {
      githubToken: requiredSecret(env, 'AGENTOPS_RUNNER_GITHUB_TOKEN'),
      provider,
      providerToken: requiredSecret(env, selectedProviderKey),
    },
  };
}

/**
 * Provider/GitHub subprocesses receive only the credentials they need. The
 * PostgreSQL credential never survives into child process environment.
 */
export function minimalExecutionEnvironment(
  credentials: RunnerCredentials,
  source: NodeJS.ProcessEnv = process.env,
  timeouts?: { commandTimeoutMs: number },
): NodeJS.ProcessEnv {
  const providerKey = PROVIDER_TOKEN_KEYS[credentials.provider];
  return {
    PATH: source.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: '/home/agentops',
    TMPDIR: '/tmp',
    LANG: source.LANG ?? 'C.UTF-8',
    LC_ALL: source.LC_ALL ?? 'C.UTF-8',
    NO_COLOR: '1',
    AGENTOPS_RUNNER_PROCESS_SANDBOX: 'bubblewrap-v1',
    ...(timeouts
      ? {
          AGENTOPS_RUNNER_COMMAND_TIMEOUT_MS:
            String(timeouts.commandTimeoutMs),
        }
      : {}),
    GH_TOKEN: credentials.githubToken,
    GITHUB_TOKEN: credentials.githubToken,
    GIT_ASKPASS: '/usr/local/bin/agentops-git-askpass',
    GIT_TERMINAL_PROMPT: '0',
    [providerKey]: credentials.providerToken,
  };
}

/** Repository graders receive no provider, GitHub, DB, control, or socket credential. */
export function isolatedGraderEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  registrationRoot?: string,
): NodeJS.ProcessEnv {
  return {
    PATH: source.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: '/tmp',
    TMPDIR: '/tmp',
    LANG: source.LANG ?? 'C.UTF-8',
    LC_ALL: source.LC_ALL ?? 'C.UTF-8',
    NO_COLOR: '1',
    AGENTOPS_RUNNER_PROCESS_SANDBOX: 'bubblewrap-v1',
    ...(registrationRoot
      ? { AGENTOPS_RUNNER_REGISTRATION_ROOT: registrationRoot }
      : {}),
  };
}

export function replaceProcessEnvironment(next: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, next);
}
