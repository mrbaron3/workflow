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

export interface PreparedRunnerWorkspace {
  registrationRoot: string;
  repositoryPath: string;
  worktreePath: string;
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
        '-C', repositoryPath, 'fetch', '--prune',
        cloneUrl, '+refs/heads/*:refs/heads/*',
      ],
      registrationRoot,
      this.env,
    );
    const targetRef = payload.target.headRef ?? payload.target.baseRef;
    const headSha = runChecked(
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
      ['-C', repositoryPath, 'branch', '-D', `runner/${lease.job.id}`],
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
        `runner/${lease.job.id}`,
        worktreePath,
        headSha,
      ],
      registrationRoot,
      this.env,
    );
    fs.mkdirSync(statePath, { recursive: true, mode: 0o700 });
    fs.mkdirSync(artifactPath, { recursive: true, mode: 0o700 });
    return {
      registrationRoot,
      repositoryPath,
      worktreePath,
      statePath,
      artifactPath,
      headSha,
    };
  }

  cleanup(workspace: PreparedRunnerWorkspace): void {
    try {
      runChecked(
        this.run,
        'git',
        [
          '-C',
          workspace.repositoryPath,
          'worktree',
          'remove',
          '--force',
          workspace.worktreePath,
        ],
        workspace.registrationRoot,
        this.env,
      );
    } catch {
      // Attempt artifacts remain durable; prune on the next deterministic prepare.
    }
    fs.rmSync(workspace.worktreePath, { recursive: true, force: true });
  }
}
