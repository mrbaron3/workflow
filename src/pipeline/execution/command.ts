import { spawnSync } from 'node:child_process';

const SECRET_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'AGENTOPS_RUNNER_DATABASE_URL',
  'AGENTOPS_CONTROL_TOKEN',
  'SSH_AUTH_SOCK',
  'CONTAINER_HOST',
  'DOCKER_HOST',
] as const;

export interface RunCommandOptions {
  credentials?: 'github' | 'none';
  timeoutMs?: number;
}

export function commandTimeoutMs(
  configured = process.env.AGENTOPS_RUNNER_COMMAND_TIMEOUT_MS,
): number {
  const value = Number(configured ?? 120_000);
  return Number.isInteger(value) && value > 0 ? value : 120_000;
}

/**
 * Harness-owned GitHub commands never inherit provider/DB/control credentials.
 * Credential-free git commands additionally lose GitHub/askpass credentials.
 */
export function commandEnvironment(
  credentials: 'github' | 'none',
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of SECRET_KEYS) delete env[key];
  if (credentials === 'none') {
    for (const key of [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GIT_ASKPASS',
      'GIT_TERMINAL_PROMPT',
    ]) {
      delete env[key];
    }
  }
  return env;
}

/** Run one grounded command and include both output streams in deterministic failures. */
export function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  options: RunCommandOptions = {},
): string {
  const credentials = options.credentials ?? (cmd === 'gh' ? 'github' : 'none');
  const commandArgs = cmd === 'git'
    ? [
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.fsmonitor=false',
        '-c', 'commit.gpgSign=false',
        '-c', 'credential.helper=',
        '-c', 'http.proxy=',
        ...args,
      ]
    : args;
  const result = spawnSync(cmd, commandArgs, {
    cwd,
    encoding: 'utf8',
    env: {
      ...commandEnvironment(credentials),
      ...(cmd === 'git'
        ? {
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
          }
        : {}),
    },
    timeout: options.timeoutMs ?? commandTimeoutMs(),
    killSignal: 'SIGKILL',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(
      `${cmd} ${args.join(' ')} failed: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result.stdout ?? '';
}
