import path from 'node:path';
import fs from 'node:fs';

const registrationRootPattern =
  /^\/workspace\/registrations\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const RUNNER_SANDBOX_MARKER = 'AGENTOPS_RUNNER_PROCESS_SANDBOX';
export const RUNNER_SANDBOX_ROOT = 'AGENTOPS_RUNNER_REGISTRATION_ROOT';
export const RUNNER_DEPENDENCY_ROOT = 'AGENTOPS_RUNNER_DEPENDENCY_ROOT';

export interface RunnerDependencyMount {
  source: string;
  target: string;
  created: boolean;
  replacedSymlinkTarget: string | null;
}

/** Prepare one already-scoped disposable target without following symlinks. */
export function prepareRunnerDependencyMountTarget(
  source: string,
  target: string,
): RunnerDependencyMount {
  let created = false;
  let replacedSymlinkTarget: string | null = null;
  let targetStat: fs.Stats | null = null;
  try {
    targetStat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (targetStat !== null) {
    if (targetStat.isSymbolicLink()) {
      // Never let bwrap resolve an untrusted checkout symlink as its mount
      // target. Quarantine it in the disposable worktree, create a real mount
      // point, then restore the exact link after the subprocess exits.
      replacedSymlinkTarget = fs.readlinkSync(target);
      fs.unlinkSync(target);
      fs.mkdirSync(target);
      created = true;
    } else if (!targetStat.isDirectory()) {
      throw new Error('runner grader node_modules mount target is unsafe');
    }
  } else {
    fs.mkdirSync(target);
    created = true;
  }
  return { source, target, created, replacedSymlinkTarget };
}

export function runnerSandboxRoot(env: NodeJS.ProcessEnv): string | null {
  if (env[RUNNER_SANDBOX_MARKER] !== 'bubblewrap-v1') return null;
  const root = env[RUNNER_SANDBOX_ROOT] ?? '';
  if (!registrationRootPattern.test(root) || path.resolve(root) !== root) {
    throw new Error('isolated runner registration sandbox root is absent or invalid');
  }
  return root;
}

/** Prepare the runner-pinned toolchain bind target before provider/grader use. */
export function prepareRunnerDependencyMount(
  env: NodeJS.ProcessEnv,
  cwd: string,
): RunnerDependencyMount | null {
  const registrationRoot = runnerSandboxRoot(env);
  if (!registrationRoot) return null;
  const resolvedCwd = path.resolve(cwd);
  if (
    resolvedCwd !== registrationRoot
    && !resolvedCwd.startsWith(`${registrationRoot}${path.sep}`)
  ) {
    throw new Error(`runner subprocess cwd escapes Registration sandbox: ${cwd}`);
  }
  const dependencyRoot = env[RUNNER_DEPENDENCY_ROOT];
  if (
    dependencyRoot !== '/app/node_modules'
    || !fs.existsSync(dependencyRoot)
    || !fs.statSync(dependencyRoot).isDirectory()
  ) {
    throw new Error('isolated runner dependency root is absent or invalid');
  }
  const target = path.join(resolvedCwd, 'node_modules');
  return prepareRunnerDependencyMountTarget(dependencyRoot, target);
}

/** Restore only mount targets created or quarantined by the runner itself. */
export function cleanupRunnerDependencyMount(
  mount: RunnerDependencyMount | null,
): void {
  if (!mount?.created) return;
  fs.rmSync(mount.target, { recursive: true, force: true });
  if (mount.replacedSymlinkTarget !== null) {
    fs.symlinkSync(mount.replacedSymlinkTarget, mount.target);
  }
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
  additionalDirs: readonly string[] = [],
): string[] {
  const resolvedCwd = path.resolve(cwd);
  if (
    !resolvedCwd.startsWith(`${registrationRoot}${path.sep}`)
  ) {
    throw new Error(`runner subprocess cwd escapes Registration sandbox: ${cwd}`);
  }
  const relativeCwd = path.relative(registrationRoot, resolvedCwd);
  const relativeSegments = relativeCwd.split(path.sep);
  if (
    relativeSegments[0] !== 'jobs'
    || !/^[0-9a-f-]{36}$/i.test(relativeSegments[1] ?? '')
    || relativeSegments.length < 3
  ) {
    throw new Error('runner subprocess cwd is not scoped to one job workspace');
  }
  const repositoryMetadata = path.join(registrationRoot, 'repository.git');
  const worktreeMetadata = path.join(resolvedCwd, '.git');
  const jobRoot = path.join(registrationRoot, 'jobs', relativeSegments[1]!);
  const realJobRoot = additionalDirs.length > 0 ? fs.realpathSync(jobRoot) : '';
  const resolvedAdditionalDirs = [...new Set(additionalDirs.map((directory) => {
    const resolved = path.resolve(directory);
    const real = fs.existsSync(resolved) ? fs.realpathSync(resolved) : '';
    if (
      !resolved.startsWith(`${jobRoot}${path.sep}`)
      || !fs.existsSync(resolved)
      || !fs.statSync(resolved).isDirectory()
      || fs.lstatSync(resolved).isSymbolicLink()
      || !real.startsWith(`${realJobRoot}${path.sep}`)
    ) {
      throw new Error(`runner additional directory escapes the active job: ${directory}`);
    }
    return resolved;
  }))];
  const mountDirectories = new Set<string>();
  for (const target of [resolvedCwd, ...resolvedAdditionalDirs]) {
    const segments = path.relative(registrationRoot, target).split(path.sep);
    let mountDirectory = registrationRoot;
    for (const segment of segments) {
      mountDirectory = path.join(mountDirectory, segment);
      mountDirectories.add(mountDirectory);
    }
  }
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
    ...[...mountDirectories].flatMap((directory) => ['--dir', directory]),
    ...(fs.existsSync(repositoryMetadata)
      ? ['--dir', repositoryMetadata, '--ro-bind', repositoryMetadata, repositoryMetadata]
      : []),
    '--bind', resolvedCwd, resolvedCwd,
    ...resolvedAdditionalDirs.flatMap((directory) => [
      '--bind', directory, directory,
    ]),
    ...(fs.existsSync(worktreeMetadata)
      ? ['--ro-bind', worktreeMetadata, worktreeMetadata]
      : []),
    ...(dependencyRoot
      ? ['--ro-bind', dependencyRoot, path.join(resolvedCwd, 'node_modules')]
      : []),
    '--tmpfs', '/tmp',
    '--tmpfs', '/home',
    '--dir', '/home/agentops',
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
  additionalDirs: readonly string[] = [],
): string {
  const registrationRoot = runnerSandboxRoot(env);
  if (!registrationRoot) return command;
  // This path launches trusted provider sessions only (tmux windows); graders
  // call runnerSandboxArgs directly and never receive a credential home.
  const providerCredentialHome = disposableProviderConfigHome(env);
  const dependencyRoot = env[RUNNER_DEPENDENCY_ROOT];
  if (dependencyRoot !== undefined && dependencyRoot !== '/app/node_modules') {
    throw new Error('isolated runner dependency root is absent or invalid');
  }
  return [
    'bwrap',
    ...runnerSandboxArgs(
      registrationRoot,
      cwd,
      '/bin/sh',
      ['-lc', command],
      dependencyRoot,
      providerCredentialHome,
      additionalDirs,
    ),
  ].map(shellQuote).join(' ');
}
