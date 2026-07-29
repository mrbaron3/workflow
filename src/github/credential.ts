import { z } from 'zod';
import { RunnerExecutionError } from '../runner/errors.js';

export const GITHUB_BROKER_ENV_KEYS = [
  'AGENTOPS_GITHUB_BROKER_URL',
  'AGENTOPS_GITHUB_BROKER_CAPABILITY',
  'AGENTOPS_GITHUB_BROKER_ROLE',
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

export function githubBrokerEnvironment(
  credential: GitHubBrokerCredential,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    PATH: source.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: '/home/agentops',
    AGENTOPS_GITHUB_BROKER_URL: credential.url,
    AGENTOPS_GITHUB_BROKER_CAPABILITY: credential.capability,
    AGENTOPS_GITHUB_BROKER_ROLE: credential.role,
    ...(source.HTTP_PROXY ? { HTTP_PROXY: source.HTTP_PROXY } : {}),
    ...(source.HTTPS_PROXY ? { HTTPS_PROXY: source.HTTPS_PROXY } : {}),
    ...(source.NO_PROXY ? { NO_PROXY: source.NO_PROXY } : {}),
  };
}
