import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import {
  EvalRun,
  IntakeRecord,
  Issue,
  PR,
  PrRevision,
  RevisionGateSnapshot,
  transitionPrRevision,
  type Finding,
} from '../src/domain/schema.js';
import { WebhookDelivery } from '../src/webhook/schema.js';
import {
  autoMergeCurrentRevision,
  evaluateRevisionGate,
  GhPrListResponse,
  GhPrViewResponse,
  MAX_REVIEW_THREAD_BODY_CHARS,
  MAX_REVIEW_THREAD_REASON_BODY_CHARS,
  observePrRevision,
  parseBlockingReviewThreads,
  reconcileSplitSourceClosures,
  type GithubPrRevisionState,
  type PrNativeGithubRunner,
} from '../src/pipeline/execution/pr-native.js';
import { Store, nowISO } from '../src/store/store.js';

const roots: string[] = [];
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const PERSPECTIVES = ['functionality', 'codeQuality', 'security'];
const CONFIG: HarnessConfig = {
  ...DEFAULT_CONFIG,
  gate: {
    backend: 'github',
    requiredChecks: ['test'],
    mergeMethod: 'squash',
  },
};

function setup(): { store: Store; pr: PR } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-pr-native-'));
  roots.push(root);
  const store = new Store(root);
  const issue = store.addIssue(Issue.parse({
    id: 'ISSUE-0001',
    type: 'feature',
    title: 'PR native delivery',
    area: 'harness',
    status: 'contract-drafted',
    assignedAgent: 'codex',
    contract: {
      productGoal: 'ship safely',
      userStory: 'As an operator I get reviewed changes',
      scope: { include: ['src/**'], exclude: [] },
      acceptanceCriteria: [{
        id: 'AC-1',
        severity: 'blocker',
        behavior: 'safe delivery',
        verification: { method: 'unit_test', expected: ['passes'] },
      }],
      redLines: [],
    },
    createdAt: nowISO(),
    updatedAt: nowISO(),
  }));
  for (const status of [
    'ready-for-generation',
    'generation-in-progress',
    'ready-for-evaluation',
    'evaluation-in-progress',
    'build-approved',
    'needs-human-review',
  ] as const) {
    store.setStatus(issue.id, status);
  }
  const pr = store.addPR(PR.parse({
    id: 'PR-0001',
    issueId: issue.id,
    branch: 'agent/issue-0001-s0',
    generator: 'codex',
    status: 'approved',
    currentRevisionId: 'PRREV-INITIAL',
    headSha: SHA_A,
    externalRef: {
      provider: 'github',
      number: 8,
      url: 'https://github.com/acme/theme/pull/8',
    },
    createdAt: nowISO(),
    updatedAt: nowISO(),
  }));
  return { store, pr };
}

function addReview(
  store: Store,
  pr: PR,
  revisionId: string,
  headSha: string,
  perspective: string,
  findings: Finding[] = [],
): void {
  store.addEvalRun(EvalRun.parse({
    id: store.nextId('EVAL'),
    issueId: pr.issueId,
    prId: pr.id,
    attempt: 1,
    sampleIndex: 0,
    agent: 'codex',
    verdict: 'approve',
    findings,
    scores: {
      functionality: 1,
      codeQuality: 1,
      testQuality: 1,
      ux: 1,
      accessibility: 1,
    },
    overall: 1,
    cost: {},
    perspective,
    revisionId,
    headSha,
    createdAt: nowISO(),
  }));
}

function greenGithub(headSha = SHA_A): GithubPrRevisionState {
  return {
    state: 'open',
    headSha,
    mergeability: 'mergeable',
    checks: [{ name: 'test', status: 'success' }],
    unresolvedBlockingThreadIds: [],
  };
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('ISSUE-0024/PR-INTENT durable lifecycle invariants', () => {
  it('rejects approved gate evidence that still contains blockers or pending reasons', () => {
    const base = {
      id: 'PRGATE-0001',
      prId: 'PR-0001',
      revisionId: 'PRREV-0001',
      headSha: SHA_A,
      mergeability: 'mergeable',
      decision: 'approved',
      createdAt: nowISO(),
    };
    expect(() => RevisionGateSnapshot.parse({
      ...base,
      blockingReasons: ['blocker survived'],
    })).toThrow();
    expect(() => RevisionGateSnapshot.parse({
      ...base,
      pendingReasons: ['check pending'],
    })).toThrow();
  });

  it('rejects malformed gh JSON instead of coercing it to a merge-eligible PR', () => {
    expect(() => GhPrViewResponse.parse({
      id: 'PR_node',
      state: 'SOMETHING_NEW',
      headRefOid: SHA_A,
      mergeable: 'MERGEABLE',
      statusCheckRollup: [],
    })).toThrow();
    expect(() => GhPrListResponse.parse([{
      number: 9,
      url: 'https://github.com/acme/theme/pull/9',
      title: 'change',
      body: '',
      headRefName: 'feature',
      headRefOid: 'not-a-sha',
      baseRefName: 'main',
      isDraft: false,
    }])).toThrow();
    expect(() => GhPrViewResponse.parse({
      id: 'PR_node',
      state: 'OPEN',
      isDraft: false,
      headRefOid: SHA_A,
      mergeable: 'MERGEABLE',
      statusCheckRollup: [{ name: '', status: 'COMPLETED' }],
    })).toThrow();
  });

  it('treats GitHub CLI empty reviewDecision as no submitted review', () => {
    expect(GhPrViewResponse.parse({
      id: 'PR_node',
      state: 'OPEN',
      isDraft: true,
      headRefOid: SHA_A,
      mergeable: 'MERGEABLE',
      reviewDecision: '',
      statusCheckRollup: [],
    }).reviewDecision).toBeNull();
  });

  it('rejects lifecycle states missing completion evidence or carrying forbidden metadata', () => {
    expect(() => PrRevision.parse({
      id: 'PRREV-0001', prId: 'PR-0001', headSha: SHA_A, ordinal: 1,
      status: 'merged', createdAt: nowISO(),
    })).toThrow();
    expect(() => WebhookDelivery.parse({
      id: 'WHDEL-0001', deliveryKey: 'd', repository: 'acme/theme',
      event: 'push', headers: {}, payload: {}, status: 'processed', attempts: 1,
      ignoredReason: 'not applicable', receivedAt: nowISO(), updatedAt: nowISO(),
    })).toThrow();
  });
});

describe('PR revision identity and automatic current-head gate', () => {
  it('PR-INTENT classifies unresolved blocking GraphQL threads and pagination safely', () => {
    const longBody = `[P0] ${'x'.repeat(MAX_REVIEW_THREAD_BODY_CHARS + 10)}`;
    const threads = parseBlockingReviewThreads({
      data: { node: { reviewThreads: {
        pageInfo: { hasNextPage: true },
        nodes: [
          { id: 'resolved', isResolved: true, path: null, line: null, comments: { pageInfo: { hasNextPage: false }, nodes: [{ body: '[P1] old' }] } },
          { id: 'p0', isResolved: false, path: null, line: null, comments: { pageInfo: { hasNextPage: false }, nodes: [{ body: longBody }] } },
          { id: 'blocker', isResolved: false, path: null, line: null, comments: { pageInfo: { hasNextPage: false }, nodes: [{ body: 'blocker: unsafe' }] } },
          { id: 'request', isResolved: false, path: null, line: null, comments: { pageInfo: { hasNextPage: false }, nodes: [{ body: 'request_changes' }] } },
          {
            id: 'overflow',
            isResolved: false,
            path: null,
            line: null,
            comments: { pageInfo: { hasNextPage: true }, nodes: [] },
          },
        ],
      } } },
    });

    expect(MAX_REVIEW_THREAD_REASON_BODY_CHARS).toBe(500);
    expect(MAX_REVIEW_THREAD_BODY_CHARS).toBe(8_000);
    expect(threads.map((thread) => thread.id)).toEqual([
      'p0', 'blocker', 'request', 'overflow', 'review-threads:pagination-incomplete',
    ]);
    expect(threads[0]!.body).toHaveLength(MAX_REVIEW_THREAD_BODY_CHARS);
    expect(threads[3]!.body).toContain('exceeded the inspected page');
  });
  it('AC-PRREV-001 reuses the durable revision for the same PR and head SHA', () => {
    const { store, pr } = setup();

    const first = observePrRevision(store, pr, SHA_A);
    const second = observePrRevision(store, pr, SHA_A);

    expect(second.id).toBe(first.id);
    expect(store.db.prRevisions.filter((row) => row.prId === pr.id && row.headSha === SHA_A)).toHaveLength(1);
  });

  it('AC-PRREV-002 invalidates an approved revision as soon as a new head is observed', () => {
    const { store, pr } = setup();
    const oldRevision = observePrRevision(store, pr, SHA_A);
    const reviewingOld = store.replacePrRevision(transitionPrRevision(oldRevision, {
      status: 'reviewing',
    }));
    store.replacePrRevision(transitionPrRevision(reviewingOld, { status: 'approved' }));

    const current = observePrRevision(store, pr, SHA_B);

    expect(store.revisionForHead(pr.id, SHA_A)?.status).toBe('stale');
    expect(store.revisionForHead(pr.id, SHA_A)?.completedAt).not.toBeNull();
    expect(current).toMatchObject({ headSha: SHA_B, ordinal: 2, status: 'pending' });
    expect(store.getPR(pr.id)).toMatchObject({ currentRevisionId: current.id, headSha: SHA_B });
  });

  it('AC-PRREV-003 requires every perspective to approve the same revision and current SHA', () => {
    const { store, pr } = setup();
    const revision = observePrRevision(store, pr, SHA_A);
    addReview(store, pr, revision.id, SHA_A, 'functionality');
    addReview(store, pr, revision.id, SHA_A, 'codeQuality');
    // A security approval for another SHA must not count.
    addReview(store, pr, revision.id, SHA_B, 'security');

    const snapshot = evaluateRevisionGate(store, {
      pr,
      revision,
      requiredPerspectives: PERSPECTIVES,
      github: greenGithub(),
      requiredChecks: ['test'],
    });

    expect(snapshot.decision).toBe('pending');
    expect(snapshot.reasons).toContain('missing review: security');
  });

  it('AC-PRLOOP-002 blocks an approved review that still contains a P1-equivalent major finding', () => {
    const { store, pr } = setup();
    const revision = observePrRevision(store, pr, SHA_A);
    for (const perspective of PERSPECTIVES) {
      addReview(
        store,
        pr,
        revision.id,
        SHA_A,
        perspective,
        perspective === 'security'
          ? [{
              criterionId: 'P1-auth-bypass',
              severity: 'major',
              expected: 'authorization is enforced',
              observed: 'approved verdict still carries P1',
              reproductionSteps: [],
              evidence: {},
              requiredFix: ['enforce authorization'],
            }]
          : [],
      );
    }

    const snapshot = evaluateRevisionGate(store, {
      pr,
      revision,
      requiredPerspectives: PERSPECTIVES,
      github: greenGithub(),
    });

    expect(snapshot.decision).toBe('changes-requested');
    expect(snapshot.reasons).toContain(
      'security has unresolved major finding P1-auth-bypass',
    );
  });

  it('AC-PRLOOP-004 AC-PRAUTO-001 blocks unresolved GitHub P1 threads even when all internal reviews approve', () => {
    const { store, pr } = setup();
    const revision = observePrRevision(store, pr, SHA_A);
    for (const perspective of PERSPECTIVES) {
      addReview(store, pr, revision.id, SHA_A, perspective);
    }

    const snapshot = evaluateRevisionGate(store, {
      pr,
      revision,
      requiredPerspectives: PERSPECTIVES,
      github: {
        ...greenGithub(),
        unresolvedBlockingThreadIds: ['PRRT-P1'],
      },
    });

    expect(snapshot.decision).toBe('changes-requested');
    expect(snapshot.reasons).toContain('unresolved blocking review thread: PRRT-P1');
  });

  it('AC-PRAUTO-002 AC-PRAUTO-003 merges with the expected current SHA only after all revision gates pass', () => {
    const { store, pr } = setup();
    const revision = observePrRevision(store, pr, SHA_A);
    for (const perspective of PERSPECTIVES) {
      addReview(store, pr, revision.id, SHA_A, perspective);
    }
    const merges: Array<{ number: number; sha: string }> = [];
    let gateWasDurableBeforeMerge = false;
    let views = 0;
    const runner: PrNativeGithubRunner = {
      viewRevision: () => {
        views += 1;
        return {
          ...greenGithub(),
          ...(views > 1 ? { state: 'merged' as const } : {}),
        };
      },
      merge: (_cwd, number, sha) => {
        gateWasDurableBeforeMerge = new Store(store.root).db.revisionGateSnapshots.some(
          (snapshot) => snapshot.headSha === sha && snapshot.decision === 'approved',
        );
        merges.push({ number, sha });
      },
      resolveReviewThread: () => {},
      closeIssue: () => {},
    };

    const result = autoMergeCurrentRevision(
      store,
      CONFIG,
      pr,
      runner,
      '/repo',
      PERSPECTIVES,
    );

    expect(result).toMatchObject({ decision: 'merged', merged: true, headSha: SHA_A });
    expect(merges).toEqual([{ number: 8, sha: SHA_A }]);
    expect(gateWasDurableBeforeMerge).toBe(true);
    expect(store.getPR(pr.id)).toMatchObject({
      status: 'merged',
      headSha: SHA_A,
      mergedHeadSha: SHA_A,
    });
    expect(store.getIssue(pr.issueId)?.status).toBe('released');
  });

  it('AC-PRAUTO-001 does not merge while a required check is pending', () => {
    const { store, pr } = setup();
    const revision = observePrRevision(store, pr, SHA_A);
    for (const perspective of PERSPECTIVES) {
      addReview(store, pr, revision.id, SHA_A, perspective);
    }
    let merges = 0;
    const runner: PrNativeGithubRunner = {
      viewRevision: () => ({
        ...greenGithub(),
        checks: [],
      }),
      merge: () => { merges += 1; },
      resolveReviewThread: () => {},
      closeIssue: () => {},
    };

    const result = autoMergeCurrentRevision(
      store,
      CONFIG,
      pr,
      runner,
      '/repo',
      PERSPECTIVES,
    );

    expect(result.decision).toBe('pending');
    expect(result.reasons).toContain('required check pending: test');
    expect(merges).toBe(0);
    expect(store.getIssue(pr.issueId)?.status).toBe('needs-human-review');
  });

  it('AC-PRAUTO-001 rejects a conflicting current head with a merge-conflicts reason', () => {
    const { store, pr } = setup();
    const revision = observePrRevision(store, pr, SHA_A);
    for (const perspective of PERSPECTIVES) addReview(store, pr, revision.id, SHA_A, perspective);

    const snapshot = evaluateRevisionGate(store, {
      pr,
      revision,
      requiredPerspectives: PERSPECTIVES,
      github: { ...greenGithub(), mergeability: 'conflicting' },
    });

    expect(snapshot.decision).toBe('changes-requested');
    expect(snapshot.reasons).toContain('pull request has merge conflicts');
  });

  it('AC-PRAUTO-001 keeps unknown mergeability pending', () => {
    const { store, pr } = setup();
    const revision = observePrRevision(store, pr, SHA_A);
    for (const perspective of PERSPECTIVES) addReview(store, pr, revision.id, SHA_A, perspective);

    const snapshot = evaluateRevisionGate(store, {
      pr,
      revision,
      requiredPerspectives: PERSPECTIVES,
      github: { ...greenGithub(), mergeability: 'unknown' },
    });

    expect(snapshot.decision).toBe('pending');
    expect(snapshot.reasons).toContain('mergeability is unknown');
  });

  it('PR-INTENT re-evaluates an unchanged changes-requested head when external gate facts recover', () => {
    const { store, pr } = setup();
    const revision = observePrRevision(store, pr, SHA_A);
    for (const perspective of PERSPECTIVES) addReview(store, pr, revision.id, SHA_A, perspective);
    store.replacePrRevision(transitionPrRevision(revision, {
      status: 'reviewing',
    }));
    const rejected = evaluateRevisionGate(store, {
      pr,
      revision,
      requiredPerspectives: PERSPECTIVES,
      github: { ...greenGithub(), mergeability: 'conflicting' },
    });
    store.addRevisionGateSnapshot(rejected);
    store.replacePrRevision(transitionPrRevision(
      store.revisionForHead(pr.id, SHA_A)!,
      { status: 'changes-requested' },
    ));
    let views = 0;
    const runner: PrNativeGithubRunner = {
      viewRevision: () => {
        views += 1;
        return views === 1 ? greenGithub() : { ...greenGithub(), state: 'merged' };
      },
      resolveReviewThread: () => {},
      merge: () => {},
      closeIssue: () => {},
    };

    const result = autoMergeCurrentRevision(
      store,
      CONFIG,
      store.getPR(pr.id)!,
      runner,
      '/repo',
      PERSPECTIVES,
    );

    expect(result).toMatchObject({ decision: 'merged', merged: true });
    expect(store.revisionForHead(pr.id, SHA_A)).toMatchObject({
      status: 'merged',
      completedAt: expect.any(String),
    });
  });

  it('AC-PRLOOP-006 reviews a draft current head but keeps automatic merge pending until it is ready', () => {
    const { store, pr } = setup();
    const revision = observePrRevision(store, pr, SHA_A);
    for (const perspective of PERSPECTIVES) {
      addReview(store, pr, revision.id, SHA_A, perspective);
    }

    const snapshot = evaluateRevisionGate(store, {
      pr,
      revision,
      requiredPerspectives: PERSPECTIVES,
      github: { ...greenGithub(), isDraft: true },
    });

    expect(snapshot.decision).toBe('pending');
    expect(snapshot.reasons).toContain('pull request is draft');
  });

  it('waits for confirmed merged state when GitHub accepts or queues a merge request', () => {
    const { store, pr } = setup();
    const revision = observePrRevision(store, pr, SHA_A);
    for (const perspective of PERSPECTIVES) {
      addReview(store, pr, revision.id, SHA_A, perspective);
    }
    let merges = 0;
    const runner: PrNativeGithubRunner = {
      viewRevision: () => greenGithub(),
      resolveReviewThread: () => {},
      merge: () => { merges += 1; },
      closeIssue: () => {},
    };

    const result = autoMergeCurrentRevision(
      store,
      CONFIG,
      pr,
      runner,
      '/repo',
      PERSPECTIVES,
    );

    expect(merges).toBe(1);
    expect(result).toMatchObject({ decision: 'pending', merged: false });
    expect(store.getPR(pr.id)?.status).toBe('approved');
    expect(store.revisionForHead(pr.id, SHA_A)?.status).toBe('approved');
    expect(store.revisionForHead(pr.id, SHA_A)?.mergeRequestedAt).not.toBeNull();
    expect(store.getIssue(pr.issueId)?.status).toBe('needs-human-review');
    expect(store.db.revisionGateSnapshots).toHaveLength(1);

    const second = autoMergeCurrentRevision(
      store,
      CONFIG,
      pr,
      runner,
      '/repo',
      PERSPECTIVES,
    );
    expect(second.decision).toBe('pending');
    expect(merges).toBe(1);
    expect(store.db.revisionGateSnapshots).toHaveLength(1);
  });

  it('keeps polling a terminal failed revision without resurrecting it as reviewing', () => {
    const { store, pr } = setup();
    const pending = observePrRevision(store, pr, SHA_A);
    const reviewing = store.replacePrRevision(transitionPrRevision(pending, {
      status: 'reviewing',
    }));
    store.replacePrRevision(transitionPrRevision(reviewing, {
      status: 'failed',
      completedAt: '2026-07-23T00:00:00.000Z',
    }));
    const runner: PrNativeGithubRunner = {
      viewRevision: () => ({ ...greenGithub(), isDraft: true }),
      resolveReviewThread: () => {},
      merge: () => { throw new Error('failed revision must not merge'); },
      closeIssue: () => {},
    };

    const result = autoMergeCurrentRevision(
      store,
      CONFIG,
      pr,
      runner,
      '/repo',
      PERSPECTIVES,
    );

    expect(result).toMatchObject({ decision: 'pending', merged: false });
    expect(store.revisionForHead(pr.id, SHA_A)?.status).toBe('failed');
  });

  it('does not convert an externally merged head without an approved snapshot into released', () => {
    const { store, pr } = setup();
    const runner: PrNativeGithubRunner = {
      viewRevision: () => ({
        ...greenGithub(),
        state: 'merged',
      }),
      merge: () => { throw new Error('must not merge twice'); },
      resolveReviewThread: () => {},
      closeIssue: () => {},
    };

    const result = autoMergeCurrentRevision(
      store,
      CONFIG,
      pr,
      runner,
      '/repo',
      PERSPECTIVES,
    );

    expect(result).toMatchObject({
      decision: 'unverified-merge',
      merged: false,
    });
    expect(store.getPR(pr.id)?.status).not.toBe('merged');
    expect(store.getIssue(pr.issueId)?.status).toBe('needs-human-review');
    expect(store.db.prRevisions[0]?.status).toBe('failed');
  });

  it('PR-INTENT keeps prior P1 threads blocking until an external reviewer resolves them', () => {
    const { store, pr } = setup();
    const oldRevision = observePrRevision(store, pr, SHA_A);
    for (const perspective of PERSPECTIVES) {
      addReview(store, pr, oldRevision.id, SHA_A, perspective);
    }
    const rejected = evaluateRevisionGate(store, {
      pr,
      revision: oldRevision,
      requiredPerspectives: PERSPECTIVES,
      github: {
        ...greenGithub(),
        unresolvedBlockingThreadIds: ['PRRT-P1'],
        blockingReviewThreads: [{
          id: 'PRRT-P1',
          body: '[P1] enforce authorization',
          path: 'src/auth.ts',
          line: 42,
        }],
      },
    });
    store.addRevisionGateSnapshot(rejected);
    const reviewingOld = store.replacePrRevision(transitionPrRevision(oldRevision, {
      status: 'reviewing',
    }));
    store.replacePrRevision(transitionPrRevision(reviewingOld, {
      status: 'changes-requested',
    }));

    const repaired = observePrRevision(store, pr, SHA_B);
    for (const perspective of PERSPECTIVES) {
      addReview(store, pr, repaired.id, SHA_B, perspective);
    }
    const resolved: string[] = [];
    const runner: PrNativeGithubRunner = {
      viewRevision: () => ({
        ...greenGithub(SHA_B),
        unresolvedBlockingThreadIds: ['PRRT-P1'],
        blockingReviewThreads: [{
          id: 'PRRT-P1',
          body: '[P1] enforce authorization',
          path: 'src/auth.ts',
          line: 42,
        }],
      }),
      resolveReviewThread: (_cwd, threadId) => { resolved.push(threadId); },
      merge: () => { throw new Error('an unresolved P1 must block merge'); },
      closeIssue: () => {},
    };

    const result = autoMergeCurrentRevision(
      store,
      CONFIG,
      pr,
      runner,
      '/repo',
      PERSPECTIVES,
    );

    expect(resolved).toEqual([]);
    expect(result).toMatchObject({ decision: 'changes-requested', merged: false });
    expect(result.reasons.join('\n')).toContain('unresolved blocking review thread: PRRT-P1');
  });

  it('AC-PRAUTO-004 closes a split Source Issue only after every child is released and records the result', () => {
    const { store } = setup();
    store.addIssue(Issue.parse({
      id: 'ISSUE-0002',
      type: 'feature',
      title: 'Sibling work',
      area: 'harness',
      status: 'contract-drafted',
      assignedAgent: 'codex',
      contract: {
        productGoal: 'ship safely',
        userStory: 'As an operator I get the sibling',
        scope: { include: ['src/**'], exclude: [] },
        acceptanceCriteria: [{
          id: 'AC-2',
          severity: 'blocker',
          behavior: 'sibling ships',
          verification: { method: 'unit_test', expected: ['passes'] },
        }],
        redLines: [],
      },
      createdAt: nowISO(),
      updatedAt: nowISO(),
    }));
    const intake = store.addIntakeRecord(IntakeRecord.parse({
      id: 'INTAKE-0001',
      intakeKey: 'acme/theme#7',
      provider: 'github',
      snapshot: {
        repository: 'acme/theme',
        number: 7,
        externalId: 'I_7',
        title: 'Split source',
        body: 'two work units',
        url: 'https://github.com/acme/theme/issues/7',
        state: 'open',
        sourceUpdatedAt: nowISO(),
        snapshotAt: nowISO(),
      },
      status: 'claimed',
      storeIssueIds: ['ISSUE-0001', 'ISSUE-0002'],
      createdAt: nowISO(),
      updatedAt: nowISO(),
    }));
    store.setStatus('ISSUE-0001', 'released');
    const closes: string[] = [];
    const runner: PrNativeGithubRunner = {
      viewRevision: () => greenGithub(),
      merge: () => {},
      resolveReviewThread: () => {},
      closeIssue: (_cwd, repository, number) => { closes.push(`${repository}#${number}`); },
    };

    reconcileSplitSourceClosures(store, runner, '/repo');
    expect(closes).toEqual([]);

    store.setStatus('ISSUE-0002', 'released');
    reconcileSplitSourceClosures(store, runner, '/repo');
    reconcileSplitSourceClosures(store, runner, '/repo');

    expect(closes).toEqual(['acme/theme#7']);
    expect(intake.sourceClosedAt).not.toBeNull();
    expect(intake.sourceCloseError).toBeNull();
  });
});
