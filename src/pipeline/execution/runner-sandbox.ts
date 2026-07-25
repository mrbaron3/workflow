import path from 'node:path';

const registrationRootPattern =
  /^\/workspace\/registrations\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const RUNNER_SANDBOX_MARKER = 'AGENTOPS_RUNNER_PROCESS_SANDBOX';
export const RUNNER_SANDBOX_ROOT = 'AGENTOPS_RUNNER_REGISTRATION_ROOT';

export function runnerSandboxRoot(env: NodeJS.ProcessEnv): string | null {
  if (env[RUNNER_SANDBOX_MARKER] !== 'bubblewrap-v1') return null;
  const root = env[RUNNER_SANDBOX_ROOT] ?? '';
  if (!registrationRootPattern.test(root) || path.resolve(root) !== root) {
    throw new Error('isolated runner registration sandbox root is absent or invalid');
  }
  return root;
}

/**
 * Hide every sibling Registration from a repository/provider process while
 * retaining the current Registration's mirror, job worktree, and artifacts.
 * Network remains the container runtime's explicitly controlled namespace.
 */
export function runnerSandboxArgs(
  registrationRoot: string,
  cwd: string,
  command: string,
  args: readonly string[],
): string[] {
  const resolvedCwd = path.resolve(cwd);
  if (
    resolvedCwd !== registrationRoot
    && !resolvedCwd.startsWith(`${registrationRoot}${path.sep}`)
  ) {
    throw new Error(`runner subprocess cwd escapes Registration sandbox: ${cwd}`);
  }
  return [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--ro-bind', '/', '/',
    '--proc', '/proc',
    '--tmpfs', '/workspace',
    '--dir', '/workspace/registrations',
    '--dir', registrationRoot,
    '--bind', registrationRoot, registrationRoot,
    '--tmpfs', '/tmp',
    '--bind', '/home/agentops', '/home/agentops',
    '--chdir', resolvedCwd,
    '--',
    command,
    ...args,
  ];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function sandboxedShellCommand(
  env: NodeJS.ProcessEnv,
  cwd: string,
  command: string,
): string {
  const registrationRoot = runnerSandboxRoot(env);
  if (!registrationRoot) return command;
  return [
    'bwrap',
    ...runnerSandboxArgs(
      registrationRoot,
      cwd,
      '/bin/sh',
      ['-lc', command],
    ),
  ].map(shellQuote).join(' ');
}
