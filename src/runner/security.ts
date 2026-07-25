import path from 'node:path';
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
  provider: z.enum(['codex', 'claude', 'gemini']),
  leaseDurationMs: z.number().int().min(5_000).max(60 * 60_000),
  heartbeatIntervalMs: z.number().int().min(500).max(10 * 60_000),
  reconciliationIntervalMs: z.number().int().min(250).max(10 * 60_000),
  maxAttempts: z.number().int().min(1).max(20),
  retryBaseMs: z.number().int().min(0).max(60 * 60_000),
  mounts: z.array(Mount),
  publishedPorts: z.array(z.number().int().min(1).max(65_535)),
  outbound: z.array(OutboundDestination).min(1),
}).strict().refine(
  (value) => value.heartbeatIntervalMs * 2 < value.leaseDurationMs,
  'heartbeat interval must be less than half the lease duration',
);
export type RunnerStartupInput = z.infer<typeof RunnerStartupInput>;

export interface RunnerCredentials {
  githubToken: string;
  provider: 'codex' | 'claude' | 'gemini';
  providerToken: string;
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
  gemini: 'GEMINI_API_KEY',
} as const;

const PROVIDER_DESTINATIONS = {
  codex: 'api.openai.com:443',
  claude: 'api.anthropic.com:443',
  gemini: 'generativelanguage.googleapis.com:443',
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
): { config: RunnerStartupInput; credentials: RunnerCredentials } {
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

  const provider = z.enum(['codex', 'claude', 'gemini']).parse(
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

  return {
    config,
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
): NodeJS.ProcessEnv {
  const providerKey = PROVIDER_TOKEN_KEYS[credentials.provider];
  return {
    PATH: source.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: '/home/agentops',
    TMPDIR: '/tmp',
    LANG: source.LANG ?? 'C.UTF-8',
    LC_ALL: source.LC_ALL ?? 'C.UTF-8',
    NO_COLOR: '1',
    GH_TOKEN: credentials.githubToken,
    GITHUB_TOKEN: credentials.githubToken,
    [providerKey]: credentials.providerToken,
  };
}

export function replaceProcessEnvironment(next: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, next);
}
