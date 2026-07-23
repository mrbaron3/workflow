import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import { EvalRun, IntakeRecord, Issue, PR, type Finding } from '../src/domain/schema.js';
import {
  autoMergeCurrentRevision,
  evaluateRevisionGate,
  observePrRevision,
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

describe('PR revision identity and automatic current-head gate', () => {
  it('invalidates an approved revision as soon as a new head is observed', () => {
    const { store, pr } = setup();
    const oldRevision = observePrRevision(store, pr, SHA_A);
    oldRevision.status = 'approved';

    const current = observePrRevision(store, pr, SHA_B);

    expect(oldRevision.status).toBe('stale');
    expect(oldRevision.completedAt).not.toBeNull();
    expect(current).toMatchObject({ headSha: SHA_B, ordinal: 2, status: 'pending' });
    expect(pr).toMatchObject({ currentRevisionId: current.id, headSha: SHA_B });
  });

  it('requires every perspective to approve the same revision and current SHA', () => {
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

  it('blocks an approved review that still contains a P1-equivalent major finding', () => {
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

  it('blocks unresolved GitHub P1 threads even when all internal reviews approve', () => {
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

  it('merges with the expected current SHA only after all revision gates pass', () => {
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
    expect(pr).toMatchObject({
      status: 'merged',
      headSha: SHA_A,
      mergedHeadSha: SHA_A,
    });
    expect(store.getIssue(pr.issueId)?.status).toBe('released');
  });

  it('does not merge while a required check is pending', () => {
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
    expect(pr.status).toBe('approved');
    expect(revision.status).toBe('approved');
    expect(revision.mergeRequestedAt).not.toBeNull();
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
    expect(pr.status).toBe('merged');
    expect(store.getIssue(pr.issueId)?.status).toBe('needs-human-review');
    expect(store.db.prRevisions[0]?.status).toBe('failed');
  });

  it('resolves prior P1 threads only after a repaired head passes fresh internal reviews', () => {
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
    oldRevision.status = 'changes-requested';

    const repaired = observePrRevision(store, pr, SHA_B);
    for (const perspective of PERSPECTIVES) {
      addReview(store, pr, repaired.id, SHA_B, perspective);
    }
    let views = 0;
    const resolved: string[] = [];
    const runner: PrNativeGithubRunner = {
      viewRevision: () => {
        views += 1;
        return views === 1
          ? {
              ...greenGithub(SHA_B),
              unresolvedBlockingThreadIds: ['PRRT-P1'],
              blockingReviewThreads: [{
                id: 'PRRT-P1',
                body: '[P1] enforce authorization',
                path: 'src/auth.ts',
                line: 42,
              }],
            }
          : views === 2
            ? greenGithub(SHA_B)
            : { ...greenGithub(SHA_B), state: 'merged' };
      },
      resolveReviewThread: (_cwd, threadId) => { resolved.push(threadId); },
      merge: () => {},
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

    expect(resolved).toEqual(['PRRT-P1']);
    expect(views).toBe(3);
    expect(result.merged).toBe(true);
  });

  it('closes a split Source Issue only after every child is released and records the result', () => {
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
