import { describe, expect, it, vi } from 'vitest';
import type {
  Lease,
  RepositoryRegistration,
  TriageDecisionV1,
} from '../src/control-store/types.js';
import {
  triageMarker,
  triageSourceDigest,
  type TriageGitHub,
  type TriageSnapshot,
} from '../src/triage/github.js';
import type { TriagePolicy } from '../src/triage/policy.js';
import type { TriageProvider } from '../src/triage/provider.js';
import { TriageRunnerService } from '../src/triage/service.js';

const policy: TriagePolicy = {
  readyLabel: 'approved-for-agent',
  claimedLabel: 'owned-by-agent',
  readyCandidateLabel: 'candidate-for-agent',
  blockedLabel: 'waiting-on-dependency',
  needsInfoLabel: 'product-input-needed',
  contextPaths: ['README.md', 'docs/NORTH_STAR.md'],
};

const decision: TriageDecisionV1 = {
  schemaVersion: 1,
  type: 'feature',
  northStarAlignment: 'aligned',
  readiness: 'blocked',
  priority: 'p1',
  summary: 'A prerequisite must land first.',
  rationale: ['The roadmap orders the prerequisite before this work.'],
  dependencies: [{
    repository: 'sample/design-system',
    issueNumber: 2,
    relationship: 'blocked_by',
  }],
  duplicateCandidates: [],
  missingInformation: [],
};

function snapshot(
  repository: string,
  labels: string[] = [],
): TriageSnapshot {
  return {
    actorLogin: 'agentops-bot',
    issue: {
      number: 4,
      title: `Triage ${repository}`,
      body: 'A product requirement.',
      state: 'open',
      updatedAt: '2026-07-29T00:00:01.000Z',
      url: `https://github.com/${repository}/issues/4`,
      labels,
      author: 'product-owner',
      isPullRequest: false,
    },
    comments: [],
    labelEvents: labels.includes(policy.readyLabel)
      ? [{
          id: 1,
          action: 'labeled',
          label: policy.readyLabel,
          actor: 'product-owner',
          createdAt: '2026-07-29T00:00:00.500Z',
        }]
      : [],
  };
}

function lease(repository: string): Lease {
  const [owner, name] = repository.split('/');
  return {
    id: 'ad837db2-30d7-4788-a56f-00056f5d550e',
    token: 'bd837db2-30d7-4788-a56f-00056f5d550e',
    workerId: 'triage-test',
    attemptId: 'cd837db2-30d7-4788-a56f-00056f5d550e',
    attemptNumber: 1,
    expiresAt: '2026-07-29T00:10:00.000Z',
    job: {
      contractVersion: 1,
      id: 'db837db2-30d7-4788-a56f-00056f5d550e',
      registrationId: 'ca3126a8-b83f-4698-90af-462523880c20',
      registrationVersion: 1,
      source: { kind: 'poll', key: `${repository}:4` },
      idempotencyKey: `${repository}:4`,
      jobType: 'agentops.triage',
      payload: {
        schemaVersion: 1,
        repository: { owner, name },
        issue: {
          number: 4,
          observedUpdatedAt: '2026-07-29T00:00:00.000Z',
        },
      },
      status: 'leased',
      createdAt: '2026-07-29T00:00:00.000Z',
    },
  };
}

function registration(repository: string): RepositoryRegistration {
  return {
    id: 'ca3126a8-b83f-4698-90af-462523880c20',
    repository,
    enabled: true,
    issueMonitorEnabled: true,
    prMonitorEnabled: true,
    executionEnabled: true,
    configuration: {},
    version: 1,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
  };
}

function setup(
  repository: string,
  snapshots: TriageSnapshot[],
) {
  const activeLease = lease(repository);
  const store = {
    reclaimExpiredLeases: vi.fn(async () => 0),
    acquireLease: vi.fn()
      .mockResolvedValueOnce(activeLease)
      .mockResolvedValue(null),
    heartbeatLease: vi.fn(async () => '2026-07-29T00:10:00.000Z'),
    getRegistration: vi.fn(async () => registration(repository)),
    finishTriageLease: vi.fn(async () => undefined),
    promoteTriageLease: vi.fn(
      async () => 'ed837db2-30d7-4788-a56f-00056f5d550e',
    ),
    failOrRetryLease: vi.fn(async () => 'failed' as const),
    listen: vi.fn(async () => async () => undefined),
  };
  const github: TriageGitHub = {
    snapshot: vi.fn(async () => snapshots.shift() ?? snapshots.at(-1)!),
    repositoryContext: vi.fn(async () => ({
      documents: [{
        path: 'docs/NORTH_STAR.md',
        content: 'Humans state WHAT; agents execute HOW.',
      }],
      openIssues: [],
    })),
    ensureManagedLabels: vi.fn(async () => undefined),
    applyManagedLabel: vi.fn(async () => [policy.blockedLabel]),
    createComment: vi.fn(
      async () => `https://github.com/${repository}/issues/4#issuecomment-1`,
    ),
  };
  const provider: TriageProvider = {
    analyze: vi.fn(async () => decision),
  };
  const service = new TriageRunnerService({
    workerId: 'triage-test',
    operatingMode: 'ACTIVE',
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 10_000,
    reconciliationIntervalMs: 250,
    maxAttempts: 3,
    retryBaseMs: 100,
    attemptTimeoutMs: 60_000,
  }, {
    store,
    github,
    provider,
    policy,
  });
  return { service, store, github, provider };
}

describe('capability-limited Issue triage runner', () => {
  it.each([
    'acme/widgets',
    'sample/design-system',
    'team-with-dashes/repo_name',
  ])('triages any registered canonical repository without a dogfood pin: %s', async (
    repository,
  ) => {
    const initial = snapshot(repository);
    const current = snapshot(repository);
    const { service, store, github, provider } = setup(
      repository,
      [initial, current],
    );

    expect(await service.runOnce()).toBe(true);
    expect(provider.analyze).toHaveBeenCalledOnce();
    expect(github.applyManagedLabel).toHaveBeenCalledWith(
      repository,
      4,
      policy.blockedLabel,
      policy,
    );
    expect(github.createComment).toHaveBeenCalledOnce();
    expect(store.promoteTriageLease).not.toHaveBeenCalled();
    expect(store.finishTriageLease).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          repository,
          outcome: 'triaged',
          appliedLabels: [policy.blockedLabel],
        }),
      }),
    );
  });

  it('promotes an exact human ready label without invoking the model or mutating GitHub', async () => {
    const repository = 'acme/widgets';
    const { service, store, github, provider } = setup(repository, [
      snapshot(repository, [policy.readyLabel]),
      snapshot(repository, [policy.readyLabel]),
    ]);

    expect(await service.runOnce()).toBe(true);
    expect(provider.analyze).not.toHaveBeenCalled();
    expect(github.ensureManagedLabels).not.toHaveBeenCalled();
    expect(github.applyManagedLabel).not.toHaveBeenCalled();
    expect(github.createComment).not.toHaveBeenCalled();
    expect(store.promoteTriageLease).toHaveBeenCalledWith(
      expect.objectContaining({
        readyLabel: policy.readyLabel,
        claimedLabel: policy.claimedLabel,
        result: expect.objectContaining({
          outcome: 'promoted',
          promotedJobId: null,
        }),
      }),
    );
  });

  it('does not repeat a triage comment for the same human-controlled source digest', async () => {
    const repository = 'acme/widgets';
    const current = snapshot(repository);
    const digest = triageSourceDigest(repository, current, policy);
    current.comments.push({
      id: 9,
      author: current.actorLogin,
      updatedAt: '2026-07-29T00:00:02.000Z',
      url: `https://github.com/${repository}/issues/4#issuecomment-9`,
      body: `${triageMarker(digest, 'blocked')}\nprior triage`,
    });
    const { service, store, github, provider } = setup(repository, [current]);

    expect(await service.runOnce()).toBe(true);
    expect(provider.analyze).not.toHaveBeenCalled();
    expect(github.applyManagedLabel).not.toHaveBeenCalled();
    expect(github.createComment).not.toHaveBeenCalled();
    expect(store.finishTriageLease).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          outcome: 'unchanged',
          sourceDigest: digest,
        }),
      }),
    );
  });

  it('retries without Issue mutation when human input changes during analysis', async () => {
    const repository = 'acme/widgets';
    const initial = snapshot(repository);
    const changed = snapshot(repository);
    changed.issue.body = 'A newly changed product requirement.';
    const { service, store, github } = setup(
      repository,
      [initial, changed],
    );

    expect(await service.runOnce()).toBe(true);
    expect(github.ensureManagedLabels).not.toHaveBeenCalled();
    expect(github.applyManagedLabel).not.toHaveBeenCalled();
    expect(github.createComment).not.toHaveBeenCalled();
    expect(store.finishTriageLease).not.toHaveBeenCalled();
    expect(store.failOrRetryLease).toHaveBeenCalledWith(
      expect.objectContaining({
        failure: expect.objectContaining({
          code: 'provider_failure',
          retryable: true,
        }),
      }),
    );
  });
});
