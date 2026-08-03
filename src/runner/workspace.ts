import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type {
  ArtifactReference,
  Lease,
  RunnerJobPayloadV1,
} from '../control-store/types.js';
import { RunnerExecutionError } from './errors.js';
import {
  commandEnvironment,
  commandTimeoutMs,
} from '../pipeline/execution/command.js';

export interface WorkspaceCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type WorkspaceCommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => WorkspaceCommandResult;

const defaultRunner: WorkspaceCommandRunner = (command, args, options) => {
  const commandArgs = command === 'git'
    ? [
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.fsmonitor=false',
        '-c', 'commit.gpgSign=false',
        '-c', 'credential.helper=',
        '-c', `http.proxy=${options.env.HTTPS_PROXY ?? ''}`,
        ...args,
      ]
    : [...args];
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    env: {
      ...commandEnvironment('github', options.env),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: commandTimeoutMs(options.env.AGENTOPS_RUNNER_COMMAND_TIMEOUT_MS),
    killSignal: 'SIGKILL',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error.message } : {}),
  };
};

const Uuid = z.string().uuid();
const JobId = z.string().uuid();
const WorkspaceManifest = z.object({
  schemaVersion: z.literal(2),
  repository: z.string().regex(/^[^/]+\/[^/]+$/),
  eventKind: z.enum(['issue', 'pull_request', 'repository']),
  eventNumber: z.number().int().positive().nullable(),
  eventIdentity: z.string().min(1).max(512).nullable(),
  headSha: z.string().regex(/^[0-9a-f]{40,64}$/),
  state: z.enum(['active', 'retained', 'cleaned']),
});

export interface PreparedRunnerWorkspace {
  registrationRoot: string;
  repositoryPath: string;
  worktreePath: string;
  /** Attempt-scoped provider/evidence/worktree root; never shared by retries. */
  harnessPath: string;
  /** Logical-job durable Store only; providers never receive this as cwd. */
  statePath: string;
  artifactPath: string;
  headSha: string;
}

function assertInside(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new RunnerExecutionError(
      'workspace_failure',
      `workspace path escapes runner volume: ${candidate}`,
      false,
    );
  }
  return resolved;
}

export function registrationWorkspacePath(root: string, registrationId: string): string {
  return assertInside(
    root,
    path.join(root, 'registrations', Uuid.parse(registrationId)),
  );
}

export function artifactUri(registrationId: string, relativePath: string): string {
  const normalized = relativePath.split(path.sep).join('/');
  if (
    path.isAbsolute(relativePath)
    || normalized.split('/').some((segment) => segment === '.' || segment === '..')
    || normalized.startsWith('../')
    || normalized.includes('/../')
    || !/^[A-Za-z0-9._/-]+$/.test(normalized)
  ) {
    throw new RunnerExecutionError(
      'artifact_integrity',
      `unsafe artifact relative path: ${relativePath}`,
      false,
    );
  }
  return `volume://registrations/${Uuid.parse(registrationId)}/${normalized}`;
}

export function resolveArtifactUri(root: string, reference: ArtifactReference): string {
  const match = reference.uri.match(
    /^volume:\/\/registrations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([A-Za-z0-9._/-]+)$/,
  );
  if (!match) {
    throw new RunnerExecutionError(
      'artifact_integrity',
      `unsupported artifact URI: ${reference.uri}`,
      false,
    );
  }
  if (match[2]!.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new RunnerExecutionError(
      'artifact_integrity',
      `artifact URI contains dot path segments: ${reference.uri}`,
      false,
    );
  }
  return assertInside(
    registrationWorkspacePath(root, match[1]!),
    path.join(root, 'registrations', match[1]!, match[2]!),
  );
}

function githubCloneUrl(payload: RunnerJobPayloadV1): string {
  return `https://github.com/${payload.repository.owner}/${payload.repository.name}.git`;
}

function runChecked(
  run: WorkspaceCommandRunner,
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  const result = run(command, args, { cwd, env });
  if (result.error || result.status !== 0) {
    throw new RunnerExecutionError(
      'workspace_failure',
      `${command} ${args.join(' ')} failed: ${(result.error ?? '')
        + (result.stdout + result.stderr).slice(-2_000)}`,
      true,
    );
  }
  return result.stdout.trim();
}

function runBestEffort(
  run: WorkspaceCommandRunner,
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): void {
  run(command, args, { cwd, env });
}

/** Stdout when the command succeeds, empty string when it fails — for probing a ref. */
function runOptional(
  run: WorkspaceCommandRunner,
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  const result = run(command, args, { cwd, env });
  return result.error || result.status !== 0 ? '' : result.stdout.trim();
}

export class RunnerWorkspaceManager {
  constructor(
    readonly root: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly run: WorkspaceCommandRunner = defaultRunner,
  ) {}

  prepare(lease: Lease, payload: RunnerJobPayloadV1): PreparedRunnerWorkspace {
    const registrationRoot = registrationWorkspacePath(
      this.root,
      lease.job.registrationId,
    );
    const repositoryPath = assertInside(
      registrationRoot,
      path.join(registrationRoot, 'repository.git'),
    );
    const jobRoot = assertInside(
      registrationRoot,
      path.join(
        registrationRoot,
        'jobs',
        JobId.parse(lease.job.id),
        `attempt-${lease.attemptNumber}`,
      ),
    );
    const worktreePath = path.join(jobRoot, 'worktree');
    const harnessPath = path.join(jobRoot, 'harness');
    // Existing AgentOps evaluation JSON remains durable for this logical job
    // across retry attempts, but can never expose another job's queue/PR state.
    const statePath = assertInside(
      registrationRoot,
      path.join(registrationRoot, 'jobs', JobId.parse(lease.job.id), 'state'),
    );
    const artifactPath = path.join(jobRoot, 'artifacts');
    fs.mkdirSync(registrationRoot, { recursive: true, mode: 0o700 });
    const cloneUrl = githubCloneUrl(payload);
    if (!fs.existsSync(repositoryPath)) {
      runChecked(
        this.run,
        'git',
        ['clone', '--mirror', cloneUrl, repositoryPath],
        registrationRoot,
        this.env,
      );
    } else {
      const origin = runChecked(
        this.run,
        'git',
        ['-C', repositoryPath, 'remote', 'get-url', 'origin'],
        registrationRoot,
        this.env,
      );
      if (origin !== cloneUrl) {
        throw new RunnerExecutionError(
          'workspace_failure',
          `registration repository origin mismatch: ${origin}`,
          false,
        );
      }
    }
    runChecked(
      this.run,
      'git',
      [
        // Fetch into remote-tracking refs, never into local branches. The harness
        // keeps worktrees of this same mirror alive (a stuck session's worktree is
        // retained for a human), and git refuses to update any branch one of them
        // has checked out — so once a generator's branch reaches the remote, a
        // refs/heads:refs/heads mirror fetch fails for every later job.
        '-C', repositoryPath, 'fetch', '--prune',
        cloneUrl, '+refs/heads/*:refs/remotes/origin/*',
      ],
      registrationRoot,
      this.env,
    );
    const targetRef = payload.target.headRef ?? payload.target.baseRef;
    // Remote-tracking first: the mirror also carries local branches created by
    // harness worktrees, and a ref present in both must resolve to what the
    // remote publishes. Local resolution stays as the fallback for refs that
    // exist only in the mirror.
    const originRef =
      `refs/remotes/origin/${targetRef.replace(/^refs\/heads\//, '')}`;
    const headSha = runOptional(
      this.run,
      'git',
      ['-C', repositoryPath, 'rev-parse', '--verify', `${originRef}^{commit}`],
      registrationRoot,
      this.env,
    ) || runChecked(
      this.run,
      'git',
      ['-C', repositoryPath, 'rev-parse', '--verify', `${targetRef}^{commit}`],
      registrationRoot,
      this.env,
    );
    if (!/^[0-9a-f]{40,64}$/.test(headSha)) {
      throw new RunnerExecutionError(
        'workspace_failure',
        `target ref did not resolve to a commit: ${targetRef}`,
        false,
      );
    }
    fs.mkdirSync(jobRoot, { recursive: true, mode: 0o700 });
    runBestEffort(
      this.run,
      'git',
      ['-C', repositoryPath, 'worktree', 'remove', '--force', worktreePath],
      registrationRoot,
      this.env,
    );
    fs.rmSync(worktreePath, { recursive: true, force: true });
    runBestEffort(
      this.run,
      'git',
      ['-C', repositoryPath, 'worktree', 'prune'],
      registrationRoot,
      this.env,
    );
    runBestEffort(
      this.run,
      'git',
      [
        '-C', repositoryPath, 'branch', '-D',
        `runner/${lease.job.id}/attempt-${lease.attemptNumber}`,
      ],
      registrationRoot,
      this.env,
    );
    runChecked(
      this.run,
      'git',
      [
        '-C',
        repositoryPath,
        'worktree',
        'add',
        '--force',
        '-B',
        `runner/${lease.job.id}/attempt-${lease.attemptNumber}`,
        worktreePath,
        headSha,
      ],
      registrationRoot,
      this.env,
    );
    fs.mkdirSync(statePath, { recursive: true, mode: 0o700 });
    fs.mkdirSync(harnessPath, { recursive: true, mode: 0o700 });
    fs.mkdirSync(artifactPath, { recursive: true, mode: 0o700 });
    const workspace = {
      registrationRoot,
      repositoryPath,
      worktreePath,
      harnessPath,
      statePath,
      artifactPath,
      headSha,
    };
    this.writeManifest(workspace, payload, 'active');
    return workspace;
  }

  private manifestPath(workspace: PreparedRunnerWorkspace): string {
    return assertInside(
      workspace.registrationRoot,
      path.join(path.dirname(workspace.worktreePath), 'workspace.json'),
    );
  }

  private writeManifest(
    workspace: PreparedRunnerWorkspace,
    payload: RunnerJobPayloadV1,
    state: 'active' | 'retained' | 'cleaned',
  ): void {
    const manifest = WorkspaceManifest.parse({
      schemaVersion: 2,
      repository: `${payload.repository.owner}/${payload.repository.name}`,
      eventKind: payload.event.kind,
      eventNumber: payload.event.kind === 'issue' || payload.event.kind === 'pull_request'
        ? payload.event.number
        : null,
      eventIdentity: payload.event.kind === 'repository' ? payload.event.identity : null,
      headSha: workspace.headSha,
      state,
    });
    fs.writeFileSync(
      this.manifestPath(workspace),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  retain(workspace: PreparedRunnerWorkspace, payload: RunnerJobPayloadV1): void {
    this.writeManifest(workspace, payload, 'retained');
  }

  /**
   * Move the durable operator checkout to an already-fetched immutable PR head.
   * The runner/job branch remains private to this attempt, so this never moves a
   * repository branch or another retained worktree.
   */
  projectHead(workspace: PreparedRunnerWorkspace, expectedHead: string): void {
    if (!/^[0-9a-f]{40,64}$/.test(expectedHead)) {
      throw new RunnerExecutionError(
        'workspace_failure',
        `operator worktree head is invalid: ${expectedHead}`,
        false,
      );
    }
    const resolved = runChecked(
      this.run,
      'git',
      ['-C', workspace.repositoryPath, 'rev-parse', '--verify', `${expectedHead}^{commit}`],
      workspace.registrationRoot,
      this.env,
    );
    if (resolved !== expectedHead) {
      throw new RunnerExecutionError(
        'workspace_failure',
        `operator worktree head did not resolve exactly: ${expectedHead}`,
        false,
      );
    }
    runChecked(
      this.run,
      'git',
      ['-C', workspace.worktreePath, 'reset', '--hard', expectedHead],
      workspace.registrationRoot,
      this.env,
    );
    const observed = runChecked(
      this.run,
      'git',
      ['-C', workspace.worktreePath, 'rev-parse', 'HEAD'],
      workspace.registrationRoot,
      this.env,
    );
    if (observed !== expectedHead) {
      throw new RunnerExecutionError(
        'workspace_failure',
        `operator worktree projection is stale: ${observed}`,
        false,
      );
    }
    workspace.headSha = observed;
  }

  cleanup(workspace: PreparedRunnerWorkspace, payload: RunnerJobPayloadV1): void {
    const jobsRoot = assertInside(
      workspace.registrationRoot,
      path.dirname(path.dirname(workspace.statePath)),
    );
    const repository = `${payload.repository.owner}/${payload.repository.name}`;
    const eventNumber = payload.event.kind === 'issue' || payload.event.kind === 'pull_request'
      ? payload.event.number
      : null;
    const eventIdentity = payload.event.kind === 'repository' ? payload.event.identity : null;
    const eventKind = payload.event.kind;
    const jobRoots = fs.existsSync(jobsRoot)
      ? fs.readdirSync(jobsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && JobId.safeParse(entry.name).success)
        .map((entry) => assertInside(jobsRoot, path.join(jobsRoot, entry.name)))
      : [];

    for (const jobRoot of jobRoots) {
      let matchedJob = false;
      let preservedWorktree = false;
      let matchedRetainedHistory = false;
      for (const entry of fs.readdirSync(jobRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^attempt-[1-9][0-9]*$/.test(entry.name)) continue;
        const attemptRoot = assertInside(jobRoot, path.join(jobRoot, entry.name));
        const worktreePath = assertInside(attemptRoot, path.join(attemptRoot, 'worktree'));
        const isCurrent = worktreePath === workspace.worktreePath;
        const manifestPath = assertInside(
          workspace.registrationRoot,
          path.join(attemptRoot, 'workspace.json'),
        );
        let manifest: z.infer<typeof WorkspaceManifest> | null = null;
        if (fs.existsSync(manifestPath) && fs.lstatSync(manifestPath).isFile()) {
          try {
            manifest = WorkspaceManifest.parse(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
          } catch {
            // Unknown metadata is never authority to delete an operator checkout.
          }
        }
        const sameRetainedEvent = manifest?.state === 'retained'
          && manifest.repository === repository
          && manifest.eventKind === eventKind
          && manifest.eventNumber === eventNumber
          && manifest.eventIdentity === eventIdentity;
        let shouldClean = isCurrent;
        if (sameRetainedEvent) {
          matchedJob = true;
          if (!isCurrent) matchedRetainedHistory = true;
          const status = this.run(
            'git',
            ['-C', worktreePath, 'status', '--porcelain', '--untracked-files=all'],
            { cwd: workspace.registrationRoot, env: this.env },
          );
          const head = this.run(
            'git',
            ['-C', worktreePath, 'rev-parse', 'HEAD'],
            { cwd: workspace.registrationRoot, env: this.env },
          );
          shouldClean = !status.error
            && status.status === 0
            && status.stdout.trim() === ''
            && !head.error
            && head.status === 0
            && head.stdout.trim() === manifest!.headSha;
          const retainedHarnessWorktrees = assertInside(
            attemptRoot,
            path.join(attemptRoot, 'harness', '.harness', 'worktrees'),
          );
          if (
            fs.existsSync(retainedHarnessWorktrees)
            && fs.readdirSync(retainedHarnessWorktrees).length > 0
          ) {
            shouldClean = false;
          }
        }
        if (!isCurrent && !sameRetainedEvent) continue;
        matchedJob = true;
        if (!shouldClean) {
          preservedWorktree = true;
          continue;
        }
        runBestEffort(
          this.run,
          'git',
          ['-C', workspace.repositoryPath, 'worktree', 'remove', '--force', worktreePath],
          workspace.registrationRoot,
          this.env,
        );
        fs.rmSync(worktreePath, { recursive: true, force: true });
        fs.rmSync(assertInside(attemptRoot, path.join(attemptRoot, 'harness')), {
          recursive: true,
          force: true,
        });
        runBestEffort(
          this.run,
          'git',
          [
            '-C', workspace.repositoryPath, 'branch', '-D',
            `runner/${path.basename(jobRoot)}/${entry.name}`,
          ],
          workspace.registrationRoot,
          this.env,
        );
        const cleaned = WorkspaceManifest.parse({
          ...(manifest ?? {
            schemaVersion: 2,
            repository,
            eventKind,
            eventNumber,
            eventIdentity,
            headSha: workspace.headSha,
          }),
          state: 'cleaned',
        });
        fs.writeFileSync(manifestPath, `${JSON.stringify(cleaned, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
      }
      if (!matchedJob || preservedWorktree) continue;
      const legacyNestedWorktrees = assertInside(
        jobRoot,
        path.join(jobRoot, 'state', '.harness', 'worktrees'),
      );
      // A retained generator checkout is an operator-facing resume surface.
      // Its original head is owned by the generator state, not this outer
      // manager, so the only fail-safe automatic policy is to preserve it.
      // Current successful jobs were never exposed and remain collectible.
      if (
        matchedRetainedHistory
        && fs.existsSync(legacyNestedWorktrees)
        && fs.readdirSync(legacyNestedWorktrees).length > 0
      ) continue;
      fs.rmSync(assertInside(jobRoot, path.join(jobRoot, 'state')), {
        recursive: true,
        force: true,
      });
      runBestEffort(
        this.run,
        'git',
        // Remove the pre-isolation branch name as upgrade garbage too.
        ['-C', workspace.repositoryPath, 'branch', '-D', `runner/${path.basename(jobRoot)}`],
        workspace.registrationRoot,
        this.env,
      );
    }
    this.run(
      'git',
      ['-C', workspace.repositoryPath, 'worktree', 'prune'],
      { cwd: workspace.registrationRoot, env: this.env },
    );
  }
}
