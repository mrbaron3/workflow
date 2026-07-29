import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import {
  githubBrokerVariables,
  loadGitHubBrokerCredential,
  type GitHubBrokerCredential,
} from '../github/credential.js';
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
  providerAuth: z.enum(['none', 'api-key', 'codex-login']),
  operatingMode: z.enum(['MONITOR_ONLY', 'ACTIVE', 'DRAINING']),
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
).superRefine((value, context) => {
  if (value.operatingMode === 'ACTIVE' && value.providerAuth === 'none') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'ACTIVE requires provider authentication',
      path: ['providerAuth'],
    });
  }
  if (value.operatingMode !== 'ACTIVE' && value.providerAuth !== 'none') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'non-ACTIVE runner must not receive provider authentication',
      path: ['providerAuth'],
    });
  }
  if (value.providerAuth === 'codex-login' && value.provider !== 'codex') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Codex login authentication requires the codex provider',
      path: ['provider'],
    });
  }
});
export type RunnerStartupInput = z.infer<typeof RunnerStartupInput>;

export type RunnerProviderAuthentication =
  | { kind: 'none'; provider: 'codex' | 'claude' }
  | { kind: 'api-key'; provider: 'codex' | 'claude'; token: string }
  | { kind: 'codex-login'; provider: 'codex'; codexHome: string };

export interface RunnerCredentials {
  githubBroker: GitHubBrokerCredential;
  providerAuthentication: RunnerProviderAuthentication;
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

const CodexAuthFile = z.object({
  auth_mode: z.enum(['chatgpt', 'apikey']),
  OPENAI_API_KEY: z.string().min(20).nullable().optional(),
  tokens: z.object({
    access_token: z.string().min(20),
    refresh_token: z.string().min(20),
    account_id: z.string().min(1),
    id_token: z.string().min(20).optional(),
  }).passthrough().nullable().optional(),
}).passthrough().superRefine((value, context) => {
  if (value.auth_mode === 'chatgpt' && !value.tokens) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'chatgpt auth requires tokens',
      path: ['tokens'],
    });
  }
  if (
    value.auth_mode === 'apikey'
    && (!value.OPENAI_API_KEY || value.OPENAI_API_KEY.length < 20)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'apikey auth requires OPENAI_API_KEY',
      path: ['OPENAI_API_KEY'],
    });
  }
});

export function validateCodexAuthFile(authPath: string): void {
  try {
    const authInfo = fs.statSync(authPath);
    if (
      !authInfo.isFile()
      || (authInfo.mode & 0o077) !== 0
      || authInfo.size < 2
      || authInfo.size > 256 * 1024
    ) {
      throw new Error('invalid metadata');
    }
    CodexAuthFile.parse(JSON.parse(fs.readFileSync(authPath, 'utf8')));
  } catch {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'Codex auth.json has an invalid private credential structure',
      false,
    );
  }
}

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

function validateRuntimeBoundary(
  boundary: RunnerRuntimeBoundary,
  requiresCredentialVolume: boolean,
): void {
  const mounts = boundary.mountInfo.split('\n').filter(Boolean).map(observedMount);
  const workspace = mounts.find((mount) => mount.target === '/workspace');
  const root = mounts.find((mount) => mount.target === '/');
  const credential = mounts.find(
    (mount) => mount.target === '/run/agentops-credentials',
  );
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
  if (
    requiresCredentialVolume
    && (
      !credential
      || !credential.options.includes('ro')
      || credential.options.includes('rw')
      || !['ext4', 'xfs', 'btrfs'].includes(credential.fsType)
      || !credential.source.startsWith('/dev/')
      || credential.majorMinor === root.majorMinor
    )
  ) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'Codex credential path is not an observed read-only private named volume',
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
  const operatingMode = z.enum(['MONITOR_ONLY', 'ACTIVE', 'DRAINING']).parse(
    env.AGENTOPS_OPERATING_MODE ?? 'MONITOR_ONLY',
  );
  const providerAuth = z.enum(['none', 'api-key', 'codex-login']).parse(
    env.AGENTOPS_RUNNER_PROVIDER_AUTH
      ?? (operatingMode === 'ACTIVE' ? 'api-key' : 'none'),
  );
  if (providerAuth === 'codex-login' && provider !== 'codex') {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'codex-login authentication is valid only for the codex provider',
      false,
    );
  }
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
    providerAuth,
    operatingMode,
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

  const workspaceMount = config.mounts.find(
    (mount) => mount.target === '/workspace',
  );
  const credentialMount = config.mounts.find(
    (mount) => mount.target === '/run/agentops-credentials',
  );
  if (!workspaceMount || workspaceMount.readOnly) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'runner must have one writable named volume mounted at /workspace',
      false,
    );
  }
  if (
    config.providerAuth !== 'codex-login'
      ? config.mounts.length !== 1
      : (
        config.mounts.length !== 2
        || !credentialMount
        || !credentialMount.readOnly
      )
  ) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'runner mounts do not match its exact provider credential boundary',
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
  const githubBroker = loadGitHubBrokerCredential(env, 'runner');
  const githubBrokerUrl = new URL(githubBroker.url);
  const required = new Set([
    `${databaseHost}:${databasePort}`,
    `${githubBrokerUrl.hostname.toLowerCase()}:${githubBrokerUrl.port}`,
    'github.com:443',
    'api.github.com:443',
  ]);
  if (config.providerAuth === 'api-key') {
    required.add(PROVIDER_DESTINATIONS[provider]);
  } else if (config.providerAuth === 'codex-login') {
    required.add('chatgpt.com:443');
    required.add('auth.openai.com:443');
  }
  if (
    required.size !== allowed.size
    || ![...required].every((destination) => allowed.has(destination))
  ) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'runner outbound allowlist does not match its exact mode and provider credential boundary',
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
  let providerAuthentication: RunnerProviderAuthentication;
  if (config.providerAuth === 'codex-login') {
    const codexHome = assertContainerNeutralPath(env.CODEX_HOME ?? '', 'CODEX_HOME');
    if (codexHome !== '/run/agentops-credentials/codex') {
      throw new RunnerExecutionError(
        'startup_isolation_failure',
        'Codex login must use /run/agentops-credentials/codex',
        false,
      );
    }
    validateCodexAuthFile(path.join(codexHome, 'auth.json'));
    providerAuthentication = {
      kind: 'codex-login',
      provider: 'codex',
      codexHome,
    };
  } else if (config.providerAuth === 'api-key') {
    providerAuthentication = {
      kind: 'api-key',
      provider,
      token: requiredSecret(env, selectedProviderKey),
    };
  } else if (env[selectedProviderKey] || env.CODEX_HOME) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'non-ACTIVE runner received a provider credential',
      false,
    );
  } else {
    providerAuthentication = { kind: 'none', provider };
  }
  if (runtimeBoundary) {
    validateRuntimeBoundary(
      runtimeBoundary,
      config.providerAuth === 'codex-login',
    );
  }

  return {
    config,
    runtimeBoundary: runtimeBoundary ?? null,
    credentials: {
      githubBroker,
      providerAuthentication,
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
  const authentication = credentials.providerAuthentication;
  const providerCredential = authentication.kind === 'api-key'
    ? { [PROVIDER_TOKEN_KEYS[authentication.provider]]: authentication.token }
    : authentication.kind === 'codex-login'
      ? { CODEX_HOME: authentication.codexHome }
      : {};
  return {
    PATH: source.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: '/home/agentops',
    TMPDIR: '/tmp',
    LANG: source.LANG ?? 'C.UTF-8',
    LC_ALL: source.LC_ALL ?? 'C.UTF-8',
    NO_COLOR: '1',
    ...(source.HTTP_PROXY ? { HTTP_PROXY: source.HTTP_PROXY } : {}),
    ...(source.HTTPS_PROXY ? { HTTPS_PROXY: source.HTTPS_PROXY } : {}),
    ...(source.NO_PROXY ? { NO_PROXY: source.NO_PROXY } : {}),
    ...(source.ALL_PROXY ? { ALL_PROXY: source.ALL_PROXY } : {}),
    AGENTOPS_RUNNER_PROCESS_SANDBOX: 'bubblewrap-v1',
    ...(timeouts
      ? {
          AGENTOPS_RUNNER_COMMAND_TIMEOUT_MS:
            String(timeouts.commandTimeoutMs),
        }
      : {}),
    ...githubBrokerVariables(credentials.githubBroker),
    GIT_ASKPASS: '/usr/local/bin/agentops-git-askpass',
    GIT_TERMINAL_PROMPT: '0',
    ...providerCredential,
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
      ? {
          AGENTOPS_RUNNER_REGISTRATION_ROOT: registrationRoot,
          AGENTOPS_RUNNER_DEPENDENCY_ROOT: '/app/node_modules',
        }
      : {}),
  };
}

export function replaceProcessEnvironment(next: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, next);
}
