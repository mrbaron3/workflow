import path from 'node:path';
import { z } from 'zod';
import { CanonicalRepository } from '../control-store/types.js';
import {
  loadGitHubBrokerCredential,
  type GitHubBrokerCredential,
} from '../github/credential.js';
import { assertContainerNeutralPath } from '../runtime/paths.js';
import {
  validateCodexAuthFile,
  type RunnerProviderAuthentication,
  type RunnerRuntimeBoundary,
} from '../runner/security.js';
import { RunnerExecutionError } from '../runner/errors.js';

const Repository = CanonicalRepository;
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

export const TriageStartupInput = z.object({
  workerId: z.string().trim().min(1).max(128),
  databaseUrl: z.string().url(),
  provider: z.enum(['codex', 'claude']),
  providerAuth: z.enum(['none', 'api-key', 'codex-login']),
  operatingMode: z.enum(['MONITOR_ONLY', 'ACTIVE', 'DRAINING']),
  repositories: z.array(Repository).min(1).max(64)
    .refine((items) => new Set(items).size === items.length),
  leaseDurationMs: z.number().int().min(5_000).max(60 * 60_000),
  heartbeatIntervalMs: z.number().int().min(500).max(10 * 60_000),
  reconciliationIntervalMs: z.number().int().min(250).max(10 * 60_000),
  maxAttempts: z.number().int().min(1).max(20),
  retryBaseMs: z.number().int().min(0).max(60 * 60_000),
  attemptTimeoutMs: z.number().int().min(5_000).max(60 * 60_000),
  mounts: z.array(Mount).max(1),
  publishedPorts: z.array(z.number().int().min(1).max(65_535)).max(0),
  outbound: z.array(OutboundDestination).min(2),
}).strict().refine(
  (value) => value.heartbeatIntervalMs * 2 < value.leaseDurationMs,
  'triage heartbeat interval must be less than half the lease duration',
).superRefine((value, context) => {
  if (value.operatingMode === 'ACTIVE' && value.providerAuth === 'none') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['providerAuth'],
      message: 'ACTIVE triage requires provider authentication',
    });
  }
  if (value.operatingMode !== 'ACTIVE' && value.providerAuth !== 'none') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['providerAuth'],
      message: 'non-ACTIVE triage must not receive provider authentication',
    });
  }
  if (value.providerAuth === 'codex-login' && value.provider !== 'codex') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['providerAuth'],
      message: 'codex-login requires the codex provider',
    });
  }
});
export type TriageStartupInput = z.infer<typeof TriageStartupInput>;

export interface TriageCredentials {
  githubBroker: GitHubBrokerCredential;
  providerAuthentication: RunnerProviderAuthentication;
}

const PROVIDER_TOKEN_KEYS = {
  codex: 'OPENAI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
} as const;
const PROVIDER_DESTINATIONS = {
  codex: 'api.openai.com:443',
  claude: 'api.anthropic.com:443',
} as const;

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      `${key} is required for the triage runner`,
      false,
    );
  }
  return value;
}

function integer(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (!raw) return fallback;
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

function json(name: string, raw: string | undefined): unknown {
  try {
    return JSON.parse(raw ?? '');
  } catch {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      `${name} must be valid JSON`,
      false,
    );
  }
}

function repositories(raw: string): string[] {
  const values = raw.split(',').map((value) => value.trim());
  if (
    values.some((value) => value === '' || value !== value.toLowerCase())
    || new Set(values).size !== values.length
  ) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'triage repository allowlist must be unique canonical owner/name values',
      false,
    );
  }
  return z.array(Repository).min(1).max(64).parse(values);
}

function validateTriageRuntime(
  boundary: RunnerRuntimeBoundary,
  credentialRequired: boolean,
): void {
  if (
    boundary.listeningTcpPorts.length > 0
    || boundary.visibleContainerSocketPaths.length > 0
  ) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'triage runner must expose no listening port or container socket',
      false,
    );
  }
  for (const forbidden of [
    '/Users/',
    '/Company/Development/',
    '/workspace',
    'docker.sock',
    'container.sock',
    '/run/host-services',
  ]) {
    if (boundary.mountInfo.includes(forbidden)) {
      throw new RunnerExecutionError(
        'startup_isolation_failure',
        `triage mount table contains forbidden marker: ${forbidden}`,
        false,
      );
    }
  }
  const root = boundary.mountInfo.split('\n').find((line) =>
    line.split(' ')[4] === '/');
  if (!root || !root.split(' ')[5]?.split(',').includes('ro')) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'triage root filesystem must be read-only',
      false,
    );
  }
  const credential = boundary.mountInfo.split('\n').find((line) =>
    line.split(' ')[4] === '/run/agentops-credentials');
  if (
    credentialRequired
    && (!credential || !credential.split(' ')[5]?.split(',').includes('ro'))
  ) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'triage Codex credential volume must be read-only',
      false,
    );
  }
}

export function loadTriageStartup(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  runtimeBoundary?: RunnerRuntimeBoundary,
): {
  config: TriageStartupInput;
  credentials: TriageCredentials;
  runtimeBoundary: RunnerRuntimeBoundary | null;
} {
  for (const key of [
    'AGENTOPS_CONTROL_TOKEN',
    'AGENTOPS_RUNNER_DATABASE_URL',
    'AGENTOPS_RUNNER_GITHUB_TOKEN',
    'SSH_AUTH_SOCK',
    'CONTAINER_HOST',
    'DOCKER_HOST',
  ]) {
    if (env[key]) {
      throw new RunnerExecutionError(
        'startup_isolation_failure',
        `forbidden triage environment variable is present: ${key}`,
        false,
      );
    }
  }
  const home = assertContainerNeutralPath(env.HOME ?? '', 'HOME');
  if (home !== '/home/agentops') {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'triage HOME must be /home/agentops',
      false,
    );
  }
  const safeCwd = assertContainerNeutralPath(cwd, 'triage cwd');
  if (safeCwd !== '/app' && !safeCwd.startsWith('/app/')) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'triage cwd must be inside /app',
      false,
    );
  }
  const provider = z.enum(['codex', 'claude']).parse(
    env.AGENTOPS_TRIAGE_PROVIDER,
  );
  const operatingMode = z.enum(['MONITOR_ONLY', 'ACTIVE', 'DRAINING']).parse(
    env.AGENTOPS_OPERATING_MODE ?? 'MONITOR_ONLY',
  );
  const providerAuth = z.enum(['none', 'api-key', 'codex-login']).parse(
    env.AGENTOPS_TRIAGE_PROVIDER_AUTH
      ?? (operatingMode === 'ACTIVE' ? 'api-key' : 'none'),
  );
  const databaseUrl = required(env, 'AGENTOPS_TRIAGE_DATABASE_URL');
  const database = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'triage database URL must use postgresql',
      false,
    );
  }
  const config = TriageStartupInput.parse({
    workerId: env.AGENTOPS_TRIAGE_WORKER_ID,
    databaseUrl,
    provider,
    providerAuth,
    operatingMode,
    repositories: repositories(required(env, 'AGENTOPS_MONITOR_REPOSITORIES')),
    leaseDurationMs: integer(env, 'AGENTOPS_TRIAGE_LEASE_MS', 60_000),
    heartbeatIntervalMs: integer(env, 'AGENTOPS_TRIAGE_HEARTBEAT_MS', 15_000),
    reconciliationIntervalMs: integer(
      env,
      'AGENTOPS_TRIAGE_RECONCILE_MS',
      5_000,
    ),
    maxAttempts: integer(env, 'AGENTOPS_TRIAGE_MAX_ATTEMPTS', 3),
    retryBaseMs: integer(env, 'AGENTOPS_TRIAGE_RETRY_BASE_MS', 5_000),
    attemptTimeoutMs: integer(
      env,
      'AGENTOPS_TRIAGE_ATTEMPT_TIMEOUT_MS',
      10 * 60_000,
    ),
    mounts: json(
      'AGENTOPS_TRIAGE_MOUNTS_JSON',
      env.AGENTOPS_TRIAGE_MOUNTS_JSON,
    ),
    publishedPorts: json(
      'AGENTOPS_TRIAGE_PUBLISHED_PORTS_JSON',
      env.AGENTOPS_TRIAGE_PUBLISHED_PORTS_JSON,
    ),
    outbound: json(
      'AGENTOPS_TRIAGE_OUTBOUND_JSON',
      env.AGENTOPS_TRIAGE_OUTBOUND_JSON,
    ),
  });
  const expectedMounts = providerAuth === 'codex-login' ? 1 : 0;
  const credentialMount = config.mounts.find((mount) =>
    mount.target === '/run/agentops-credentials');
  if (
    config.mounts.length !== expectedMounts
    || (
      expectedMounts === 1
      && (!credentialMount || !credentialMount.readOnly)
    )
  ) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'triage mounts do not match the credential-only boundary',
      false,
    );
  }
  const allowed = new Set(config.outbound.map((destination) =>
    `${destination.host}:${destination.port}`));
  const databaseDestination =
    `${database.hostname.toLowerCase()}:${Number(database.port || 5432)}`;
  const githubBroker = loadGitHubBrokerCredential(env, 'triage');
  const githubBrokerUrl = new URL(githubBroker.url);
  const requiredDestinations = new Set([
    databaseDestination,
    `${githubBrokerUrl.hostname.toLowerCase()}:${githubBrokerUrl.port}`,
    'api.github.com:443',
  ]);
  if (providerAuth === 'api-key') {
    requiredDestinations.add(PROVIDER_DESTINATIONS[provider]);
  } else if (providerAuth === 'codex-login') {
    requiredDestinations.add('chatgpt.com:443');
    requiredDestinations.add('auth.openai.com:443');
  }
  if (
    allowed.size !== requiredDestinations.size
    || [...requiredDestinations].some((item) => !allowed.has(item))
  ) {
    throw new RunnerExecutionError(
      'startup_isolation_failure',
      'triage outbound allowlist does not match its exact capabilities',
      false,
    );
  }
  const selectedProviderKey = PROVIDER_TOKEN_KEYS[provider];
  for (const [candidate, key] of Object.entries(PROVIDER_TOKEN_KEYS)) {
    if (candidate !== provider && env[key]) {
      throw new RunnerExecutionError(
        'startup_isolation_failure',
        `credential for unselected triage provider is present: ${key}`,
        false,
      );
    }
  }
  let providerAuthentication: RunnerProviderAuthentication;
  if (providerAuth === 'codex-login') {
    const codexHome = assertContainerNeutralPath(env.CODEX_HOME ?? '', 'CODEX_HOME');
    if (codexHome !== '/run/agentops-credentials/codex') {
      throw new RunnerExecutionError(
        'startup_isolation_failure',
        'triage Codex login must use the credential volume',
        false,
      );
    }
    validateCodexAuthFile(path.join(codexHome, 'auth.json'));
    providerAuthentication = {
      kind: 'codex-login',
      provider: 'codex',
      codexHome,
    };
  } else if (providerAuth === 'api-key') {
    providerAuthentication = {
      kind: 'api-key',
      provider,
      token: required(env, selectedProviderKey),
    };
  } else {
    if (env[selectedProviderKey] || env.CODEX_HOME) {
      throw new RunnerExecutionError(
        'startup_isolation_failure',
        'non-ACTIVE triage received a provider credential',
        false,
      );
    }
    providerAuthentication = { kind: 'none', provider };
  }
  if (runtimeBoundary) {
    validateTriageRuntime(runtimeBoundary, providerAuth === 'codex-login');
  }
  return {
    config,
    credentials: {
      githubBroker,
      providerAuthentication,
    },
    runtimeBoundary: runtimeBoundary ?? null,
  };
}

export function minimalTriageProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
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
  };
}

export function minimalTriageProviderEnvironment(
  credentials: TriageCredentials,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const authentication = credentials.providerAuthentication;
  const providerCredential = authentication.kind === 'api-key'
    ? { [PROVIDER_TOKEN_KEYS[authentication.provider]]: authentication.token }
    : authentication.kind === 'codex-login'
      ? { CODEX_HOME: authentication.codexHome }
      : {};
  return {
    ...minimalTriageProcessEnvironment(source),
    ...providerCredential,
  };
}
