import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { RunnerExecutionError } from '../runner/errors.js';

const execFileAsync = promisify(execFile);

const CREDENTIAL_HELPER = '/usr/local/bin/agentops-github-credential-helper';

/** Mirrors actorLogin in contracts/github-credential/v1/token-response.schema.json. */
const ActorLogin = z.string().min(6).max(106)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\[bot\]$/);

export const GITHUB_BROKER_ENV_KEYS = [
  'AGENTOPS_GITHUB_BROKER_URL',
  'AGENTOPS_GITHUB_BROKER_CAPABILITY',
  'AGENTOPS_GITHUB_BROKER_ROLE',
  'AGENTOPS_GITHUB_REPOSITORY',
] as const;

export interface GitHubBrokerCredential {
  url: string;
  capability: string;
  role: 'triage' | 'runner';
}

function failure(message: string): never {
  throw new RunnerExecutionError(
    'startup_isolation_failure',
    message,
    false,
  );
}

export function loadGitHubBrokerCredential(
  env: NodeJS.ProcessEnv,
  expectedRole: GitHubBrokerCredential['role'],
): GitHubBrokerCredential {
  for (const key of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'AGENTOPS_TRIAGE_GITHUB_TOKEN',
    'AGENTOPS_RUNNER_GITHUB_TOKEN',
    'AGENTOPS_CONTROL_GITHUB_TOKEN',
  ]) {
    if (env[key]) {
      failure(`static GitHub credential is forbidden: ${key}`);
    }
  }
  const rawUrl = env.AGENTOPS_GITHUB_BROKER_URL?.trim();
  let brokerUrl: URL;
  try {
    brokerUrl = new URL(rawUrl ?? '');
  } catch {
    failure('AGENTOPS_GITHUB_BROKER_URL must be an internal HTTP endpoint');
  }
  if (
    brokerUrl!.protocol !== 'http:'
    || brokerUrl!.username !== ''
    || brokerUrl!.password !== ''
    || brokerUrl!.hostname === ''
    || brokerUrl!.port === ''
    || brokerUrl!.pathname !== '/'
    || brokerUrl!.search !== ''
    || brokerUrl!.hash !== ''
  ) {
    failure('AGENTOPS_GITHUB_BROKER_URL must be an internal HTTP endpoint');
  }
  const port = Number(brokerUrl!.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    failure('AGENTOPS_GITHUB_BROKER_URL has an invalid port');
  }
  const capability = z.string()
    .regex(/^[A-Za-z0-9_-]{43,128}$/)
    .safeParse(env.AGENTOPS_GITHUB_BROKER_CAPABILITY?.trim());
  if (!capability.success) {
    failure('AGENTOPS_GITHUB_BROKER_CAPABILITY is invalid');
  }
  const role = z.enum(['triage', 'runner']).safeParse(
    env.AGENTOPS_GITHUB_BROKER_ROLE?.trim(),
  );
  if (!role.success || role.data !== expectedRole) {
    failure('GitHub credential broker role does not match this process');
  }
  return {
    url: brokerUrl!.toString(),
    capability: capability.data,
    role: role.data,
  };
}

/**
 * Just the three broker variables, for callers that already own the rest of the
 * child environment. Composing this into an existing environment keeps that
 * caller's PATH/HOME authoritative instead of silently redefining them.
 */
export function githubBrokerVariables(
  credential: GitHubBrokerCredential,
): NodeJS.ProcessEnv {
  return {
    AGENTOPS_GITHUB_BROKER_URL: credential.url,
    AGENTOPS_GITHUB_BROKER_CAPABILITY: credential.capability,
    AGENTOPS_GITHUB_BROKER_ROLE: credential.role,
  };
}

/** The whole minimal environment for a `gh`/helper subprocess. */
export function githubBrokerEnvironment(
  credential: GitHubBrokerCredential,
  repository: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const parsedRepository = z.string().regex(
    /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/,
  ).parse(repository);
  return {
    PATH: source.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: '/home/agentops',
    ...githubBrokerVariables(credential),
    AGENTOPS_GITHUB_REPOSITORY: parsedRepository,
    ...(source.HTTP_PROXY ? { HTTP_PROXY: source.HTTP_PROXY } : {}),
    ...(source.HTTPS_PROXY ? { HTTPS_PROXY: source.HTTPS_PROXY } : {}),
    ...(source.NO_PROXY ? { NO_PROXY: source.NO_PROXY } : {}),
  };
}

export type ActorLoginCommand = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout: string }>;

const defaultActorLoginCommand: ActorLoginCommand = async (
  file,
  args,
  options,
) => {
  const result = await execFileAsync(file, [...args], {
    encoding: 'utf8',
    timeout: options.timeout,
    maxBuffer: 8 * 1024,
    killSignal: 'SIGKILL',
    env: options.env,
  });
  return { stdout: result.stdout };
};

/**
 * The broker verified this identity against the live GitHub App before it
 * minted anything, so the actor is read back out of the credential rather than
 * configured a second time where it could drift from the App itself. The helper
 * prints only the login — the installation token never enters this process.
 */
export async function resolveGitHubActorLogin(
  credential: GitHubBrokerCredential,
  run: ActorLoginCommand = defaultActorLoginCommand,
): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await run(CREDENTIAL_HELPER, ['actor'], {
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: '/home/agentops',
        ...githubBrokerVariables(credential),
      },
      timeout: 30_000,
    }));
  } catch {
    failure('GitHub App actor identity was unavailable from the broker');
  }
  const parsed = ActorLogin.safeParse(stdout!.trim());
  if (!parsed.success) {
    failure('GitHub App actor identity from the broker is invalid');
  }
  return parsed.data;
}
