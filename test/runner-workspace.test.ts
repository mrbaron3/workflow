import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Lease, RunnerJobPayloadV1 } from '../src/control-store/types.js';
import { verifyArtifactReferences } from '../src/runner/artifacts.js';
import {
  DEFAULT_RETAINED_WORKSPACE_TTL_MS,
  RunnerWorkspaceManager,
  artifactUri,
  registrationWorkspacePath,
  type WorkspaceCommandRunner,
} from '../src/runner/workspace.js';

const registrationId = 'ca3126a8-b83f-4698-90af-462523880c20';
const jobId = 'db837db2-30d7-4788-a56f-00056f5d550e';
const sha = 'a'.repeat(40);

function lease(): Lease {
  return {
    id: 'ad837db2-30d7-4788-a56f-00056f5d550e',
    token: 'bd837db2-30d7-4788-a56f-00056f5d550e',
    workerId: 'runner-1',
    attemptId: 'cd837db2-30d7-4788-a56f-00056f5d550e',
    attemptNumber: 2,
    expiresAt: '2026-07-25T00:10:00.000Z',
    job: {
      contractVersion: 1,
      id: jobId,
      registrationId,
      registrationVersion: 3,
      source: { kind: 'manual', key: 'test' },
      idempotencyKey: 'test',
      jobType: 'agentops.runner',
      payload: {},
      status: 'leased',
      createdAt: '2026-07-25T00:00:00.000Z',
    },
  };
}

function payload(): RunnerJobPayloadV1 {
  return {
    schemaVersion: 1,
    repository: { owner: 'mrbaron3', name: 'workflow' },
    event: { kind: 'issue', number: 14, action: 'labeled' },
    target: { baseRef: 'refs/heads/main' },
    execution: {
      mode: 'development_turn',
      requiredChecks: [],
      mergeMethod: 'squash',
      readyLabel: 'ready',
      claimedLabel: 'agent-claimed',
    },
    artifacts: [],
  };
}

describe('Registration-rooted runner workspace', () => {
  it('derives deterministic paths only from the private root and Registration ID', () => {
    expect(registrationWorkspacePath('/workspace', registrationId))
      .toBe(`/workspace/registrations/${registrationId}`);
    expect(() => registrationWorkspacePath('/workspace', '../../escape')).toThrow();
    expect(artifactUri(registrationId, 'jobs/id/artifacts/result.json'))
      .toBe(
        `volume://registrations/${registrationId}/jobs/id/artifacts/result.json`,
      );
    expect(() => artifactUri(registrationId, '../outside')).toThrow();
  });

  it('uses a derived HTTPS clone URL and deterministic attempt worktree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-workspace-'));
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner: WorkspaceCommandRunner = (command, args) => {
      calls.push({ command, args });
      if (args[0] === 'clone') fs.mkdirSync(String(args.at(-1)), { recursive: true });
      if (args.includes('add')) {
        const index = args.indexOf('add');
        const worktree = String(args[index + 4]);
        fs.mkdirSync(worktree, { recursive: true });
      }
      if (args.includes('rev-parse')) {
        return { status: 0, stdout: `${sha}\n`, stderr: '' };
      }
      if (args.includes('get-url')) {
        return {
          status: 0,
          stdout: 'https://github.com/mrbaron3/workflow.git\n',
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const manager = new RunnerWorkspaceManager(root, { PATH: '/usr/bin' }, runner);
    const prepared = manager.prepare(lease(), payload());
    expect(calls.find((call) => call.args[0] === 'clone')?.args).toContain(
      'https://github.com/mrbaron3/workflow.git',
    );
    expect(prepared.worktreePath).toBe(
      path.join(
        root,
        'registrations',
        registrationId,
        'jobs',
        jobId,
        'attempt-2',
        'worktree',
      ),
    );
    expect(prepared.statePath).toBe(
      path.join(root, 'registrations', registrationId, 'jobs', jobId, 'state'),
    );
    expect(prepared.harnessPath).toBe(
      path.join(
        root,
        'registrations',
        registrationId,
        'jobs',
        jobId,
        'attempt-2',
        'harness',
      ),
    );
    expect(prepared.headSha).toBe(sha);
  });

  it('checks out a review child from the durable exact parent head and fails on drift', () => {
    const makeRunner = (resolvedHead: string): WorkspaceCommandRunner =>
      (_command, args) => {
        if (args[0] === 'clone') fs.mkdirSync(String(args.at(-1)), { recursive: true });
        if (args.includes('add')) {
          const index = args.indexOf('add');
          fs.mkdirSync(String(args[index + 4]), { recursive: true });
        }
        if (args.includes('rev-parse')) {
          return { status: 0, stdout: `${resolvedHead}\n`, stderr: '' };
        }
        if (args.includes('get-url')) {
          return {
            status: 0,
            stdout: 'https://github.com/mrbaron3/workflow.git\n',
            stderr: '',
          };
        }
        return { status: 0, stdout: '', stderr: '' };
      };
    const childPayload: RunnerJobPayloadV1 = {
      ...payload(),
      target: { baseRef: 'agent/parent-14', headRef: sha },
      lineage: {
        nodeId: '11111111-1111-4111-8111-111111111111',
        parentNodeId: '22222222-2222-4222-8222-222222222222',
        parentIssueNumber: 13,
        parentPullRequestNumber: 44,
        parentBranch: 'agent/parent-14',
        parentHeadSha: sha,
        reviewRound: 1,
      },
    };
    const matchingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-child-head-'));
    const prepared = new RunnerWorkspaceManager(
      matchingRoot,
      { PATH: '/usr/bin' },
      makeRunner(sha),
    ).prepare(lease(), childPayload);
    expect(prepared.headSha).toBe(sha);

    const driftRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-child-drift-'));
    expect(() => new RunnerWorkspaceManager(
      driftRoot,
      { PATH: '/usr/bin' },
      makeRunner('b'.repeat(40)),
    ).prepare(lease(), childPayload)).toThrow(/parent head moved/);
  });

  // The harness keeps worktrees of this same mirror alive, and git refuses to update a
  // branch any worktree has checked out. Once a generator's branch reaches the remote, a
  // refs/heads:refs/heads mirror fetch fails for every later job — so the mirror must only
  // ever write remote-tracking refs, and resolve targets from there first.
  it('fetches into remote-tracking refs and resolves the target from origin first', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-mirror-'));
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const originSha = 'b'.repeat(40);
    const runner: WorkspaceCommandRunner = (command, args) => {
      calls.push({ command, args });
      if (args[0] === 'clone') fs.mkdirSync(String(args.at(-1)), { recursive: true });
      if (args.includes('add')) {
        const index = args.indexOf('add');
        fs.mkdirSync(String(args[index + 4]), { recursive: true });
      }
      if (args.includes('rev-parse')) {
        const ref = String(args.at(-1));
        if (ref.startsWith('refs/remotes/origin/')) {
          return { status: 0, stdout: `${originSha}\n`, stderr: '' };
        }
        return { status: 0, stdout: `${sha}\n`, stderr: '' };
      }
      if (args.includes('get-url')) {
        return { status: 0, stdout: 'https://github.com/mrbaron3/workflow.git\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const prepared = new RunnerWorkspaceManager(root, { PATH: '/usr/bin' }, runner)
      .prepare(lease(), payload());
    const fetch = calls.find((call) => call.args.includes('fetch'));
    expect(fetch?.args).toContain('+refs/heads/*:refs/remotes/origin/*');
    expect(fetch?.args.join(' ')).not.toContain('refs/heads/*:refs/heads/*');
    expect(prepared.headSha).toBe(originSha);
  });

  it('falls back to the local ref when the target is absent from origin', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-mirror-local-'));
    const runner: WorkspaceCommandRunner = (command, args) => {
      if (args[0] === 'clone') fs.mkdirSync(String(args.at(-1)), { recursive: true });
      if (args.includes('add')) {
        const index = args.indexOf('add');
        fs.mkdirSync(String(args[index + 4]), { recursive: true });
      }
      if (args.includes('rev-parse')) {
        const ref = String(args.at(-1));
        if (ref.startsWith('refs/remotes/origin/')) {
          return { status: 1, stdout: '', stderr: 'unknown revision' };
        }
        return { status: 0, stdout: `${sha}\n`, stderr: '' };
      }
      if (args.includes('get-url')) {
        return { status: 0, stdout: 'https://github.com/mrbaron3/workflow.git\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const prepared = new RunnerWorkspaceManager(root, { PATH: '/usr/bin' }, runner)
      .prepare(lease(), payload());
    expect(prepared.headSha).toBe(sha);
  });

  it('projects the retained attempt checkout to the exact fetched PR head', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-pr-head-'));
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const prHead = 'c'.repeat(40);
    const registrationRoot = registrationWorkspacePath(root, registrationId);
    const prepared = {
      registrationRoot,
      repositoryPath: path.join(registrationRoot, 'repository.git'),
      worktreePath: path.join(registrationRoot, 'jobs', jobId, 'attempt-2', 'worktree'),
      harnessPath: path.join(registrationRoot, 'jobs', jobId, 'attempt-2', 'harness'),
      statePath: path.join(registrationRoot, 'jobs', jobId, 'state'),
      artifactPath: path.join(registrationRoot, 'jobs', jobId, 'attempt-2', 'artifacts'),
      headSha: sha,
    };
    const runner: WorkspaceCommandRunner = (command, args) => {
      calls.push({ command, args });
      if (args.includes('rev-parse')) {
        return { status: 0, stdout: `${prHead}\n`, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const manager = new RunnerWorkspaceManager(root, { PATH: '/usr/bin' }, runner);

    manager.projectHead(prepared, prHead);

    expect(calls.some((call) => call.args.join(' ') === [
      '-C', prepared.worktreePath, 'reset', '--hard', prHead,
    ].join(' '))).toBe(true);
    expect(prepared.headSha).toBe(prHead);
    expect(() => manager.projectHead(prepared, 'refs/heads/main')).toThrow(/invalid/);
  });

  it('keeps a failed attempt live while preparing an isolated retry of the same job', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-real-retry-'));
    const source = path.join(root, 'source');
    const remote = path.join(root, 'remote.git');
    fs.mkdirSync(source);
    const git = (args: string[], cwd = root) => {
      const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
      });
      if (result.status !== 0) throw new Error(result.stderr || result.error?.message);
      return result.stdout.trim();
    };
    git(['init', '--initial-branch=main'], source);
    git(['config', 'user.email', 'runner@example.invalid'], source);
    git(['config', 'user.name', 'Runner Test'], source);
    fs.writeFileSync(path.join(source, 'README.md'), 'base\n');
    git(['add', 'README.md'], source);
    git(['commit', '-m', 'base'], source);
    git(['clone', '--bare', source, remote]);

    const expectedUrl = 'https://github.com/mrbaron3/workflow.git';
    const runner: WorkspaceCommandRunner = (command, args, options) => {
      const translated = [...args];
      if (translated[0] === 'clone') translated[2] = remote;
      const fetchUrl = translated.indexOf(expectedUrl);
      if (fetchUrl >= 0) translated[fetchUrl] = remote;
      if (translated.includes('get-url')) {
        return { status: 0, stdout: `${expectedUrl}\n`, stderr: '' };
      }
      const result = spawnSync(command, translated, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env, GIT_CONFIG_NOSYSTEM: '1' },
        encoding: 'utf8',
      });
      return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        ...(result.error ? { error: result.error.message } : {}),
      };
    };
    const manager = new RunnerWorkspaceManager(root, process.env, runner);
    const first = manager.prepare(lease(), payload());
    manager.retain(first, payload());
    const retryLease = lease();
    retryLease.attemptNumber = 3;
    retryLease.attemptId = 'dd837db2-30d7-4788-a56f-00056f5d550e';
    const retry = manager.prepare(retryLease, payload());

    expect(fs.existsSync(first.worktreePath)).toBe(true);
    expect(fs.existsSync(retry.worktreePath)).toBe(true);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], first.worktreePath))
      .toBe(`runner/${jobId}/attempt-2`);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], retry.worktreePath))
      .toBe(`runner/${jobId}/attempt-3`);

    fs.writeFileSync(path.join(first.worktreePath, 'operator-notes.txt'), 'keep me\n');
    git(['config', 'user.email', 'operator@example.invalid'], retry.worktreePath);
    git(['config', 'user.name', 'Operator'], retry.worktreePath);
    fs.writeFileSync(path.join(retry.worktreePath, 'manual-fix.txt'), 'committed fix\n');
    git(['add', 'manual-fix.txt'], retry.worktreePath);
    git(['commit', '-m', 'manual retained fix'], retry.worktreePath);
    manager.retain(retry, payload());

    const succeedingLease = lease();
    succeedingLease.attemptNumber = 4;
    succeedingLease.attemptId = 'ed837db2-30d7-4788-a56f-00056f5d550e';
    const succeeding = manager.prepare(succeedingLease, payload());
    manager.cleanup(succeeding, payload());

    expect(fs.existsSync(first.worktreePath)).toBe(true);
    expect(fs.existsSync(retry.worktreePath)).toBe(true);
    expect(fs.existsSync(succeeding.worktreePath)).toBe(false);
    expect(fs.readFileSync(path.join(first.worktreePath, 'operator-notes.txt'), 'utf8'))
      .toBe('keep me\n');
    expect(git(['log', '-1', '--format=%s'], retry.worktreePath)).toBe('manual retained fix');
  });

  it('keeps an attempt-scoped generator worktree isolated across retry and later cleanup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-resolved-gc-'));
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner: WorkspaceCommandRunner = (command, args) => {
      calls.push({ command, args });
      if (args[0] === 'clone') fs.mkdirSync(String(args.at(-1)), { recursive: true });
      if (args.includes('add')) {
        const index = args.indexOf('add');
        fs.mkdirSync(String(args[index + 4]), { recursive: true });
      }
      if (args.includes('rev-parse')) return { status: 0, stdout: `${sha}\n`, stderr: '' };
      if (args.includes('get-url')) {
        return { status: 0, stdout: 'https://github.com/mrbaron3/workflow.git\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const manager = new RunnerWorkspaceManager(root, { PATH: '/usr/bin' }, runner);
    const retained = manager.prepare(lease(), payload());
    const retainedArtifact = path.join(retained.artifactPath, 'result.json');
    fs.writeFileSync(retainedArtifact, '{}\n');
    const nestedOperatorFile = path.join(
      retained.harnessPath,
      '.harness',
      'worktrees',
      'ISSUE-0014-s0',
      'operator-fix.txt',
    );
    fs.mkdirSync(path.dirname(nestedOperatorFile), { recursive: true });
    fs.writeFileSync(nestedOperatorFile, 'manual nested edit\n');
    manager.retain(retained, payload());

    const retryLease = lease();
    retryLease.attemptNumber = 3;
    retryLease.attemptId = 'fd837db2-30d7-4788-a56f-00056f5d550e';
    const retry = manager.prepare(retryLease, payload());
    const retryNestedFile = path.join(
      retry.harnessPath,
      '.harness',
      'worktrees',
      'ISSUE-0014-s0',
      'retry.txt',
    );
    fs.mkdirSync(path.dirname(retryNestedFile), { recursive: true });
    fs.writeFileSync(retryNestedFile, 'retry edit\n');
    manager.retain(retry, payload());
    expect(retry.harnessPath).not.toBe(retained.harnessPath);
    expect(fs.readFileSync(nestedOperatorFile, 'utf8')).toBe('manual nested edit\n');

    const unrelatedLease = lease();
    unrelatedLease.job.id = 'fb837db2-30d7-4788-a56f-00056f5d550e';
    unrelatedLease.attemptNumber = 1;
    const unrelatedPayload = {
      ...payload(),
      event: { kind: 'issue' as const, number: 15, action: 'labeled' as const },
    };
    const unrelated = manager.prepare(unrelatedLease, unrelatedPayload);
    manager.retain(unrelated, unrelatedPayload);

    const succeedingLease = lease();
    succeedingLease.job.id = 'eb837db2-30d7-4788-a56f-00056f5d550e';
    succeedingLease.attemptNumber = 1;
    const succeeding = manager.prepare(succeedingLease, payload());
    const removesBeforeCleanup = calls.filter((call) => call.args.includes('remove')).length;
    manager.cleanup(succeeding, payload());

    expect(fs.existsSync(retained.worktreePath)).toBe(true);
    expect(fs.existsSync(retry.worktreePath)).toBe(true);
    expect(fs.existsSync(succeeding.worktreePath)).toBe(false);
    expect(fs.existsSync(unrelated.worktreePath)).toBe(true);
    expect(fs.existsSync(retainedArtifact)).toBe(true);
    expect(fs.readFileSync(nestedOperatorFile, 'utf8')).toBe('manual nested edit\n');
    expect(fs.readFileSync(retryNestedFile, 'utf8')).toBe('retry edit\n');
    expect(calls.filter((call) => call.args.includes('remove'))).toHaveLength(
      removesBeforeCleanup + 1,
    );
    expect(JSON.parse(fs.readFileSync(
      path.join(path.dirname(retained.worktreePath), 'workspace.json'),
      'utf8',
    ))).toMatchObject({ state: 'retained', eventKind: 'issue', eventNumber: 14 });
  });

  it('reclaims a retained attempt only after its inspection window elapses', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-retention-ttl-'));
    const runner: WorkspaceCommandRunner = (command, args) => {
      if (args[0] === 'clone') fs.mkdirSync(String(args.at(-1)), { recursive: true });
      if (args.includes('add')) {
        const index = args.indexOf('add');
        fs.mkdirSync(String(args[index + 4]), { recursive: true });
      }
      if (args.includes('rev-parse')) return { status: 0, stdout: `${sha}\n`, stderr: '' };
      if (args.includes('get-url')) {
        return { status: 0, stdout: 'https://github.com/mrbaron3/workflow.git\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const environment = { PATH: '/usr/bin' };
    const manager = new RunnerWorkspaceManager(root, environment, runner);
    const retained = manager.prepare(lease(), payload());
    fs.writeFileSync(path.join(retained.harnessPath, 'evidence.json'), '{}\n');
    manager.retain(retained, payload());
    const manifestPath = path.join(path.dirname(retained.worktreePath), 'workspace.json');
    const retainedAt = Date.parse(
      JSON.parse(fs.readFileSync(manifestPath, 'utf8')).retainedAt,
    );

    // Inside the window the operator's checkout is untouchable, even though no
    // later job for this event ever succeeds to release it opportunistically.
    expect(manager.pruneExpiredRetainedWorkspaces(
      retained.registrationRoot,
      retained.repositoryPath,
      retainedAt + DEFAULT_RETAINED_WORKSPACE_TTL_MS - 1,
    )).toEqual([]);
    expect(fs.existsSync(retained.worktreePath)).toBe(true);

    const reclaimed = manager.pruneExpiredRetainedWorkspaces(
      retained.registrationRoot,
      retained.repositoryPath,
      retainedAt + DEFAULT_RETAINED_WORKSPACE_TTL_MS,
    );

    expect(reclaimed).toEqual([path.dirname(retained.worktreePath)]);
    expect(fs.existsSync(retained.worktreePath)).toBe(false);
    expect(fs.existsSync(retained.harnessPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))
      .toMatchObject({ state: 'cleaned', retainedAt: null });
    // Already reclaimed: a second sweep is a no-op, not a repeated deletion.
    expect(manager.pruneExpiredRetainedWorkspaces(
      retained.registrationRoot,
      retained.repositoryPath,
      retainedAt + DEFAULT_RETAINED_WORKSPACE_TTL_MS * 10,
    )).toEqual([]);
  });

  it('never reclaims a retained attempt when retention expiry is disabled', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-retention-off-'));
    const runner: WorkspaceCommandRunner = (command, args) => {
      if (args[0] === 'clone') fs.mkdirSync(String(args.at(-1)), { recursive: true });
      if (args.includes('add')) {
        const index = args.indexOf('add');
        fs.mkdirSync(String(args[index + 4]), { recursive: true });
      }
      if (args.includes('rev-parse')) return { status: 0, stdout: `${sha}\n`, stderr: '' };
      if (args.includes('get-url')) {
        return { status: 0, stdout: 'https://github.com/mrbaron3/workflow.git\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const manager = new RunnerWorkspaceManager(
      root,
      { PATH: '/usr/bin', AGENTOPS_RUNNER_RETAINED_WORKSPACE_TTL_MS: '0' },
      runner,
    );
    const retained = manager.prepare(lease(), payload());
    manager.retain(retained, payload());

    expect(manager.pruneExpiredRetainedWorkspaces(
      retained.registrationRoot,
      retained.repositoryPath,
      Date.now() + DEFAULT_RETAINED_WORKSPACE_TTL_MS * 100,
    )).toEqual([]);
    expect(fs.existsSync(retained.worktreePath)).toBe(true);
  });

  it('accepts exact artifact digest/size and rejects tampering or cross-Registration reuse', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-artifact-'));
    const registrationRoot = registrationWorkspacePath(root, registrationId);
    const file = path.join(registrationRoot, 'inputs', 'review.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"approved":true}\n');
    const bytes = fs.readFileSync(file);
    const reference = {
      uri: artifactUri(registrationId, 'inputs/review.json'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength,
      createdAt: '2026-07-25T00:00:00.000Z',
    };
    expect(() => verifyArtifactReferences(root, registrationId, [reference]))
      .not.toThrow();
    fs.appendFileSync(file, 'tampered');
    expect(() => verifyArtifactReferences(root, registrationId, [reference]))
      .toThrow(/mismatch/);
    expect(() => verifyArtifactReferences(
      root,
      'db837db2-30d7-4788-a56f-00056f5d550e',
      [reference],
    )).toThrow(/another Registration/);
  });

  it('rejects an artifact whose parent symlink resolves outside the Registration root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-artifact-link-'));
    const registrationRoot = registrationWorkspacePath(root, registrationId);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-outside-'));
    const outsideFile = path.join(outside, 'review.json');
    fs.writeFileSync(outsideFile, '{"approved":true}\n');
    fs.mkdirSync(path.join(registrationRoot, 'inputs'), { recursive: true });
    fs.symlinkSync(outside, path.join(registrationRoot, 'inputs', 'linked'));
    const bytes = fs.readFileSync(outsideFile);
    const reference = {
      uri: artifactUri(registrationId, 'inputs/linked/review.json'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength,
      createdAt: '2026-07-25T00:00:00.000Z',
    };
    expect(() => verifyArtifactReferences(root, registrationId, [reference]))
      .toThrow(/outside the Registration workspace/);
  });
});
