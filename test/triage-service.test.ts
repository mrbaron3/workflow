import { describe, expect, it, vi } from 'vitest';
import type {
  Lease,
  RepositoryRegistration,
  TriageDecisionV1,
} from '../src/control-store/types.js';
import {
  MAX_TRIAGE_BODY_CHARS,
  TriageSourceTooLargeError,
  triageMarker,
  triageSourceDigest,
  type TriageGitHub,
  type TriageSnapshot,
} from '../src/triage/github.js';
import type { TriagePolicy } from '../src/triage/policy.js';
import type { TriageProvider } from '../src/triage/provider.js';
import {
  TriageRunnerService,
  boundedProgressBlocker,
} from '../src/triage/service.js';
import { releaseSourceIssueSnapshotDigest } from '../src/control-store/types.js';

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

it('bounds durable needs-info detail without splitting Unicode characters', () => {
  const blocker = boundedProgressBlocker(Array.from({ length: 16 }, () => '不足'.repeat(250)));
  expect(Array.from(blocker)).toHaveLength(1_000);
  expect(blocker.endsWith('…')).toBe(true);
});

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
          createdAt: '2026-07-29T00:00:01.000Z',
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
    recordDevelopmentProgress: vi.fn(async () => 1),
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
  it('turns an unfreezable oversized Source Issue into a human-facing blocker', async () => {
    const repository = 'acme/widgets';
    const { service, store, github, provider } = setup(repository, [snapshot(repository)]);
    // Requirements are frozen verbatim or not at all, so an over-limit Issue is
    // a human-fixable shape problem — it must name the limit, not fail opaquely.
    (github.snapshot as ReturnType<typeof vi.fn>).mockRejectedValue(
      new TriageSourceTooLargeError(
        `Issue body is 1000001 characters; the limit is ${MAX_TRIAGE_BODY_CHARS}`,
      ),
    );

    expect(await service.runOnce()).toBe(true);

    expect(provider.analyze).not.toHaveBeenCalled();
    expect(store.promoteTriageLease).not.toHaveBeenCalled();
    expect(store.recordDevelopmentProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          eventKey: 'triage:source-too-large',
          phase: 'human-review',
          state: 'blocked',
          blocker: expect.stringContaining(String(MAX_TRIAGE_BODY_CHARS)),
        }),
      }),
    );
    expect(store.failOrRetryLease).toHaveBeenCalledWith(
      expect.objectContaining({
        failure: expect.objectContaining({ retryable: false }),
      }),
    );
  });

  it('keeps requirements identity stable across capture metadata retries', () => {
    const core = {
      repository: 'acme/widgets',
      number: 4,
      title: 'Requirement',
      body: 'Do the thing.',
      url: 'https://github.com/acme/widgets/issues/4',
      labels: ['ready'],
      comments: [],
      state: 'open' as const,
      sourceUpdatedAt: '2026-07-29T00:00:01.000Z',
      capturedAt: '2026-07-29T00:00:01.000Z',
    };
    expect(releaseSourceIssueSnapshotDigest(core)).toBe(
      releaseSourceIssueSnapshotDigest({
        ...core,
        labels: ['agent-claimed'],
        sourceUpdatedAt: '2026-07-29T00:00:02.000Z',
        capturedAt: '2026-07-29T00:00:03.000Z',
      }),
    );
    expect(releaseSourceIssueSnapshotDigest(core)).not.toBe(
      releaseSourceIssueSnapshotDigest({ ...core, body: 'Changed requirement.' }),
    );
    expect(releaseSourceIssueSnapshotDigest(core)).not.toBe(
      releaseSourceIssueSnapshotDigest({
        ...core,
        comments: [{
          id: 1,
          body: 'Clarified mandatory behavior.',
          updatedAt: '2026-07-29T00:00:01.000Z',
          url: 'https://github.com/acme/widgets/issues/4#issuecomment-1',
          author: 'product-owner',
        }],
      }),
    );
  });
  it.each([
    'acme/widgets',
    'sample/design-system',
    'team-with-dashes/repo_name',
  ])('triages any registered canonical repository without a dogfood pin: %s', async (
    repository,
  ) => {
    const initial = snapshot(repository);
    const current = snapshot(repository);
    initial.issue.body += '\n\nParent: #1';
    current.issue.body += '\n\nParent: #1';
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
    expect(store.recordDevelopmentProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          eventKey: 'triage:blocked',
          phase: 'human-review',
          state: 'blocked',
          blocker: expect.stringContaining('roadmap'),
          parentIssueNumber: 1,
        }),
      }),
    );
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
    const ready = snapshot(repository, [policy.readyLabel]);
    ready.issue.body += '\n\nParent: #1';
    ready.comments = [{
      id: 7,
      body: 'The compatibility floor is Node 22.',
      updatedAt: '2026-07-29T00:00:00.500Z',
      url: 'https://github.com/acme/widgets/issues/4#issuecomment-7',
      author: 'product-owner',
    }];
    const { service, store, github, provider } = setup(repository, [
      ready,
      structuredClone(ready),
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
        authority: expect.objectContaining({
          sourceIssue: expect.objectContaining({
            comments: [expect.objectContaining({
              id: 7,
              body: 'The compatibility floor is Node 22.',
            })],
          }),
        }),
      }),
    );
    // The freeze is announced as in-flight, never as done: promotion closes this
    // lease, so a later `succeeded` write would be rejected anyway — and a
    // failed promotion must not leave a durable event claiming it happened.
    expect(store.recordDevelopmentProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          eventKey: 'triage:ready-authority-frozen',
          parentIssueNumber: 1,
          state: 'running',
        }),
      }),
    );
    const frozenStates = store.recordDevelopmentProgress.mock.calls
      .map((call) => (call as unknown as [{ event: { eventKey: string; state: string } }])[0].event)
      .filter((event) => event.eventKey === 'triage:ready-authority-frozen')
      .map((event) => event.state);
    expect(frozenStates).toEqual(['running']);
  });

  it('rejects an authoritative comment added after the latest human ready event', async () => {
    const repository = 'acme/widgets';
    const changed = snapshot(repository, [policy.readyLabel]);
    changed.comments = [{
      id: 8,
      body: 'New requirement after ready.',
      updatedAt: '2026-07-29T00:00:02.000Z',
      url: 'https://github.com/acme/widgets/issues/4#issuecomment-8',
      author: 'product-owner',
    }];
    const { service, store } = setup(repository, [changed, structuredClone(changed)]);

    expect(await service.runOnce()).toBe(true);
    expect(store.promoteTriageLease).not.toHaveBeenCalled();
    expect(store.failOrRetryLease).toHaveBeenCalledWith(expect.objectContaining({
      failure: expect.objectContaining({
        message: expect.stringContaining('reapply the ready label'),
      }),
    }));
  });

  it('rejects Issue requirements edited after the latest human ready event', async () => {
    const repository = 'acme/widgets';
    const edited = snapshot(repository, [policy.readyLabel]);
    edited.issue.updatedAt = '2026-07-29T00:00:02.000Z';
    const { service, store } = setup(repository, [edited, edited]);

    expect(await service.runOnce()).toBe(true);
    expect(store.promoteTriageLease).not.toHaveBeenCalled();
    expect(store.failOrRetryLease).toHaveBeenCalledWith(expect.objectContaining({
      failure: expect.objectContaining({
        code: 'provider_failure',
        retryable: false,
        message: expect.stringContaining('reapply the ready label'),
      }),
    }));
  });

  it('revalidates eligibility on the second ready snapshot', async () => {
    const repository = 'acme/widgets';
    const initial = snapshot(repository, [policy.readyLabel]);
    const closed = snapshot(repository, [policy.readyLabel]);
    closed.issue.state = 'closed';
    const { service, store } = setup(repository, [initial, closed]);

    expect(await service.runOnce()).toBe(true);
    expect(store.promoteTriageLease).not.toHaveBeenCalled();
    expect(store.failOrRetryLease).toHaveBeenCalledWith(expect.objectContaining({
      failure: expect.objectContaining({ code: 'provider_failure', retryable: false }),
    }));
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
