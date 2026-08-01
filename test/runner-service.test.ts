import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PostgresControlStore } from '../src/control-store/store.js';
import type {
  Lease,
  RunnerJobPayloadV1,
} from '../src/control-store/types.js';
import type { AgentOpsRunnerAdapter } from '../src/runner/adapter.js';
import { IsolatedRunnerService } from '../src/runner/service.js';
import type {
  PreparedRunnerWorkspace,
  RunnerWorkspaceManager,
} from '../src/runner/workspace.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

const registrationId = 'ca3126a8-b83f-4698-90af-462523880c20';
const jobId = 'db837db2-30d7-4788-a56f-00056f5d550e';

function payload(): RunnerJobPayloadV1 {
  return {
    schemaVersion: 1,
    repository: { owner: 'owner', name: 'repo' },
    event: { kind: 'issue', number: 14, action: 'labeled' },
    target: { baseRef: 'refs/heads/main' },
    execution: {
      mode: 'development_turn',
      requiredChecks: [],
      mergeMethod: 'squash',
      readyLabel: 'human-approved',
      claimedLabel: 'automation-owned',
    },
    artifacts: [],
  };
}

function lease(): Lease {
  return {
    id: 'ad837db2-30d7-4788-a56f-00056f5d550e',
    token: 'bd837db2-30d7-4788-a56f-00056f5d550e',
    workerId: 'runner-service',
    attemptId: 'cd837db2-30d7-4788-a56f-00056f5d550e',
    attemptNumber: 1,
    expiresAt: '2026-07-31T00:10:00.000Z',
    job: {
      contractVersion: 1,
      id: jobId,
      registrationId,
      registrationVersion: 1,
      source: { kind: 'manual', key: 'human-review' },
      idempotencyKey: 'human-review',
      jobType: 'agentops.runner',
      payload: payload(),
      status: 'leased',
      createdAt: '2026-07-31T00:00:00.000Z',
    },
  };
}

describe('isolated runner terminal outcomes', () => {
  it('finishes needs-human-review once as a successful terminal outcome without retrying', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-human-review-'));
    roots.push(root);
    const registrationRoot = path.join(root, 'registrations', registrationId);
    const artifactPath = path.join(
      registrationRoot,
      'jobs',
      jobId,
      'attempt-1',
      'artifacts',
    );
    const worktreePath = path.join(
      registrationRoot,
      'jobs',
      jobId,
      'attempt-1',
      'worktree',
    );
    fs.mkdirSync(artifactPath, { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });
    const prepared: PreparedRunnerWorkspace = {
      registrationRoot,
      repositoryPath: path.join(registrationRoot, 'repository.git'),
      worktreePath,
      statePath: path.join(registrationRoot, 'jobs', jobId, 'state'),
      artifactPath,
      headSha: 'a'.repeat(40),
    };
    const activeLease = lease();
    const finishLease = vi.fn(async (
      _token: string,
      _outcome: unknown,
    ) => {});
    const failOrRetryLease = vi.fn(async () => 'queued' as const);
    const linkLeaseArtifact = vi.fn(async () => {});
    const acquireLease = vi.fn()
      .mockResolvedValueOnce(activeLease)
      .mockResolvedValue(null);
    const store = {
      reclaimExpiredLeases: vi.fn(async () => 0),
      acquireLease,
      getRegistration: vi.fn(async () => ({
        id: registrationId,
        repository: 'owner/repo',
        enabled: true,
        issueMonitorEnabled: true,
        prMonitorEnabled: true,
        executionEnabled: true,
        configuration: {},
        version: 1,
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:00:00.000Z',
      })),
      assertExecutionGuard: vi.fn(async () => ({
        ok: true,
        reason: null,
        registration: null,
        jobId,
        leaseExpiresAt: activeLease.expiresAt,
      })),
      linkLeaseArtifact,
      finishLease,
      failOrRetryLease,
    } as unknown as PostgresControlStore;
    const cleanup = vi.fn();
    const workspace = {
      prepare: vi.fn(() => prepared),
      cleanup,
    } as unknown as RunnerWorkspaceManager;
    const reasons = [
      'planning ambiguity: choose a conflict policy',
      'planning ambiguity: define the compatibility floor',
    ];
    const adapter: AgentOpsRunnerAdapter = {
      async execute() {
        return {
          outcome: 'needs-human-review',
          humanReview: {
            issueNumber: 14,
            reasons,
            commentUrl:
              'https://github.com/owner/repo/issues/14#issuecomment-1',
          },
          headSha: null,
          pullRequestNumber: null,
          developmentTurn: {
            intake: [],
            enrichmentIds: ['ENRICH-0001'],
            driveResults: [],
          },
        };
      },
    };
    const service = new IsolatedRunnerService({
      operatingMode: 'ACTIVE',
      workerId: activeLease.workerId,
      workspaceRoot: root,
      provider: 'codex',
      leaseDurationMs: 600_000,
      heartbeatIntervalMs: 300_000,
      reconciliationIntervalMs: 250,
      maxAttempts: 3,
      retryBaseMs: 0,
      attemptTimeoutMs: 600_000,
    }, {
      store,
      workspace,
      adapter,
    });

    await expect(service.runOnce()).resolves.toBe(true);

    expect(failOrRetryLease).not.toHaveBeenCalled();
    expect(finishLease).toHaveBeenCalledTimes(1);
    expect(finishLease.mock.calls[0]?.[1]).toMatchObject({
      status: 'succeeded',
      result: {
        status: 'succeeded',
        outcome: 'needs-human-review',
        headSha: null,
        pullRequestNumber: null,
        humanReview: {
          issueNumber: 14,
          reasonCount: 2,
          classification: 'what-judgment',
          howIntervention: false,
          aiAppliedReadyLabel: false,
          claimedLabelRemoved: true,
        },
      },
    });
    expect(linkLeaseArtifact).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith(prepared);
    const artifact = JSON.parse(fs.readFileSync(
      path.join(artifactPath, 'runner-result.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(artifact).toMatchObject({
      outcome: 'needs-human-review',
      humanReview: {
        reasons,
        classification: 'what-judgment',
        howIntervention: false,
      },
    });
  });

  it('does not reverse a completed release when workspace cleanup fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-cleanup-failure-'));
    roots.push(root);
    const registrationRoot = path.join(root, 'registrations', registrationId);
    const artifactPath = path.join(
      registrationRoot,
      'jobs',
      jobId,
      'attempt-1',
      'artifacts',
    );
    const worktreePath = path.join(
      registrationRoot,
      'jobs',
      jobId,
      'attempt-1',
      'worktree',
    );
    fs.mkdirSync(artifactPath, { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });
    const prepared: PreparedRunnerWorkspace = {
      registrationRoot,
      repositoryPath: path.join(registrationRoot, 'repository.git'),
      worktreePath,
      statePath: path.join(registrationRoot, 'jobs', jobId, 'state'),
      artifactPath,
      headSha: 'a'.repeat(40),
    };
    const activeLease = lease();
    const finishLease = vi.fn(async () => {});
    const failOrRetryLease = vi.fn(async () => 'queued' as const);
    const log = vi.fn();
    const store = {
      reclaimExpiredLeases: vi.fn(async () => 0),
      acquireLease: vi.fn().mockResolvedValueOnce(activeLease),
      getRegistration: vi.fn(async () => ({
        id: registrationId,
        repository: 'owner/repo',
        enabled: true,
        issueMonitorEnabled: true,
        prMonitorEnabled: true,
        executionEnabled: true,
        configuration: {},
        version: 1,
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:00:00.000Z',
      })),
      assertExecutionGuard: vi.fn(async () => ({
        ok: true,
        reason: null,
        registration: null,
        jobId,
        leaseExpiresAt: activeLease.expiresAt,
      })),
      linkLeaseArtifact: vi.fn(async () => {}),
      finishLease,
      failOrRetryLease,
    } as unknown as PostgresControlStore;
    const cleanup = vi.fn(() => {
      throw new Error('temporary worktree removal failure');
    });
    const workspace = {
      prepare: vi.fn(() => prepared),
      cleanup,
    } as unknown as RunnerWorkspaceManager;
    const adapter: AgentOpsRunnerAdapter = {
      async execute() {
        return {
          outcome: 'completed',
          humanReview: null,
          headSha: prepared.headSha,
          pullRequestNumber: 38,
          developmentTurn: {
            intake: [],
            enrichmentIds: [],
            driveResults: [],
          },
        };
      },
    };
    const service = new IsolatedRunnerService({
      operatingMode: 'ACTIVE',
      workerId: activeLease.workerId,
      workspaceRoot: root,
      provider: 'codex',
      leaseDurationMs: 600_000,
      heartbeatIntervalMs: 300_000,
      reconciliationIntervalMs: 250,
      maxAttempts: 3,
      retryBaseMs: 0,
      attemptTimeoutMs: 600_000,
    }, {
      store,
      workspace,
      adapter,
      log,
    });

    await expect(service.runOnce()).resolves.toBe(true);

    expect(finishLease).toHaveBeenCalledWith(activeLease.token, expect.objectContaining({
      status: 'succeeded',
      result: expect.objectContaining({
        outcome: 'completed',
        headSha: prepared.headSha,
        pullRequestNumber: 38,
      }),
    }));
    expect(failOrRetryLease).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledWith(prepared);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(
      'runner workspace cleanup failed',
    ));
  });
});
