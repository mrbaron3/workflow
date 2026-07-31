import path from 'node:path';
import fs from 'node:fs';

const registrationRootPattern =
  /^\/workspace\/registrations\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const RUNNER_SANDBOX_MARKER = 'AGENTOPS_RUNNER_PROCESS_SANDBOX';
export const RUNNER_SANDBOX_ROOT = 'AGENTOPS_RUNNER_REGISTRATION_ROOT';
export const RUNNER_DEPENDENCY_ROOT = 'AGENTOPS_RUNNER_DEPENDENCY_ROOT';

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
  dependencyRoot?: string,
  providerCredentialHome?: string,
): string[] {
  const resolvedCwd = path.resolve(cwd);
  if (
    resolvedCwd !== registrationRoot
    && !resolvedCwd.startsWith(`${registrationRoot}${path.sep}`)
  ) {
    throw new Error(`runner subprocess cwd escapes Registration sandbox: ${cwd}`);
  }
  const repositoryMetadata = path.join(registrationRoot, 'repository.git');
  const worktreeMetadata = path.join(resolvedCwd, '.git');
  return [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--ro-bind', '/', '/',
    // Trusted provider processes need the credential volume; repository code
    // instead receives an empty /run tree.
    '--tmpfs', '/run',
    // Provider sessions get their credential home back under the /run tmpfs: a
    // writable directory (codex writes session state there) plus the read-only
    // auth file. Grader/repository invocations never pass one.
    ...(providerCredentialHome
      ? [
          '--dir', providerCredentialHome,
          ...(fs.existsSync(path.join(providerCredentialHome, 'auth.json'))
            ? [
                '--ro-bind',
                path.join(providerCredentialHome, 'auth.json'),
                path.join(providerCredentialHome, 'auth.json'),
              ]
            : []),
        ]
      : []),
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/workspace',
    '--dir', '/workspace/registrations',
    '--dir', registrationRoot,
    '--bind', registrationRoot, registrationRoot,
    ...(fs.existsSync(repositoryMetadata)
      ? ['--ro-bind', repositoryMetadata, repositoryMetadata]
      : []),
    ...(fs.existsSync(worktreeMetadata)
      ? ['--ro-bind', worktreeMetadata, worktreeMetadata]
      : []),
    ...(dependencyRoot
      ? ['--ro-bind', dependencyRoot, path.join(resolvedCwd, 'node_modules')]
      : []),
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

/**
 * The provider config home when it is a disposable per-session copy inside the sandbox — a tmpfs
 * directory holding a read-only bind of the auth file. Callers may write provider configuration
 * there. Returns undefined for anything else, which is what keeps an operator's own `~/.codex`
 * from ever being rewritten by a session launch.
 */
export function disposableProviderConfigHome(
  env: NodeJS.ProcessEnv,
): string | undefined {
  const home = env.CODEX_HOME ?? '';
  return home.startsWith('/run/agentops-credentials/')
    && path.resolve(home) === home
    ? home
    : undefined;
}

export function sandboxedShellCommand(
  env: NodeJS.ProcessEnv,
  cwd: string,
  command: string,
): string {
  const registrationRoot = runnerSandboxRoot(env);
  if (!registrationRoot) return command;
  // This path launches trusted provider sessions only (tmux windows); graders
  // call runnerSandboxArgs directly and never receive a credential home.
  const providerCredentialHome = disposableProviderConfigHome(env);
  return [
    'bwrap',
    ...runnerSandboxArgs(
      registrationRoot,
      cwd,
      '/bin/sh',
      ['-lc', command],
      undefined,
      providerCredentialHome,
    ),
  ].map(shellQuote).join(' ');
}
