import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ApprovedRevisionGateSnapshot,
  emptyDB,
  PR,
  PrHeadSha,
  PrRevision,
  RevisionBinding,
  approvePR,
  bindApprovalRevisionToPR,
  bindMergeRevisionToPR,
  mergeApprovedPR,
  transitionPR,
  transitionPrRevision,
  updatePR,
  validatePRTransition,
  validatePrRevisionTransition,
} from '../src/domain/schema.js';
import { Store, nowISO } from '../src/store/store.js';

const roots: string[] = [];
function approvedGate(
  prId: string,
  revisionId: string,
  headSha: string,
) {
  return ApprovedRevisionGateSnapshot.parse({
    id: `PRGATE-${revisionId}`,
    prId,
    revisionId,
    headSha,
    requiredPerspectives: [],
    perspectiveVerdicts: {},
    checks: [],
    unresolvedBlockingThreadIds: [],
    blockingReviewThreads: [],
    mergeability: 'mergeable',
    decision: 'approved',
    blockingReasons: [],
    pendingReasons: [],
    reasons: [],
    createdAt: nowISO(),
  });
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('PR lifecycle values', () => {
  it('PR-INTENT makes PR and revision identity mutations compile-time invalid', () => {
    const open = PR.parse({
      id: 'PR-1', issueId: 'ISSUE-1', branch: 'feature', generator: 'mock',
      currentRevisionId: 'PRREV-1', headSha: 'a'.repeat(40),
      createdAt: nowISO(), updatedAt: nowISO(),
    });
    const pending = PrRevision.parse({
      id: 'PRREV-1', prId: 'PR-1', headSha: 'a'.repeat(40), ordinal: 1,
      status: 'pending', createdAt: nowISO(),
    });
    if (false) {
      const badUpdate = { id: 'PR-2' };
      const badPrTransition = { status: 'closed' as const, issueId: 'ISSUE-2' };
      const badRevisionTransition = {
        status: 'reviewing' as const,
        headSha: PrHeadSha.parse('b'.repeat(40)),
      };
      // @ts-expect-error update metadata cannot contain durable PR identity
      updatePR(open, badUpdate);
      // @ts-expect-error transition destinations cannot contain issue ownership
      transitionPR(open, badPrTransition);
      // @ts-expect-error revision destinations contain state and evidence only
      transitionPrRevision(pending, badRevisionTransition);
      // @ts-expect-error a pending revision cannot mint approval authority
      bindApprovalRevisionToPR(open, pending, approvedGate(open.id, pending.id, pending.headSha));
    }
    expect(open.id).toBe('PR-1');
    expect(pending.id).toBe('PRREV-1');
  });

  it('PR-INTENT rejects short SHAs and partial revision bindings', () => {
    expect(PrHeadSha.safeParse('abc1234').success).toBe(false);
    expect(PrHeadSha.safeParse('a'.repeat(40)).success).toBe(true);
    expect(RevisionBinding.safeParse({
      revisionId: 'PRREV-1',
      headSha: null,
    }).success).toBe(false);
    expect(PR.safeParse({
      id: 'PR-1',
      issueId: 'ISSUE-1',
      branch: 'feature',
      generator: 'mock',
      currentRevisionId: 'PRREV-1',
      headSha: null,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    }).success).toBe(false);
  });

  it('PR-INTENT requires approved PRs to identify a concrete current revision and head', () => {
    const base = {
      id: 'PR-1', issueId: 'ISSUE-1', branch: 'feature', generator: 'mock' as const,
      status: 'approved' as const, createdAt: nowISO(), updatedAt: nowISO(),
    };
    expect(() => PR.parse(base)).toThrow();
  });

  it('PR-INTENT transitions atomically to deeply readonly validated variants', () => {
    const open = PR.parse({
      id: 'PR-1', issueId: 'ISSUE-1', branch: 'feature', generator: 'mock',
      currentRevisionId: 'PRREV-1', headSha: 'a'.repeat(40),
      createdAt: nowISO(), updatedAt: nowISO(),
    });
    const revision = PrRevision.parse({
      id: 'PRREV-1', prId: open.id, headSha: 'a'.repeat(40), ordinal: 1,
      status: 'approved', createdAt: nowISO(),
    });
    if (revision.status !== 'approved') throw new Error('fixture must be approved');
    const binding = bindApprovalRevisionToPR(
      open,
      revision,
      approvedGate(open.id, revision.id, revision.headSha),
    );
    const authorization = approvePR(open, binding);
    const approved = authorization.pr;
    expect(Object.isFrozen(approved)).toBe(true);
    const merged = mergeApprovedPR(
      approved,
      bindMergeRevisionToPR(authorization),
    );
    expect(merged.headSha).toBe(merged.mergedHeadSha);
    if (false) {
      const invalidApproval = {
        status: 'approved' as const,
        currentRevisionId: 'PRREV-other',
        headSha: PrHeadSha.parse('b'.repeat(40)),
      };
      // @ts-expect-error approval coordinates cannot be supplied independently
      transitionPR(open, invalidApproval);
    }
    // mergeApprovedPR exposes no second SHA input; both persisted fields are
    // derived from the opaque binding.
    expect(approved).toMatchObject({ status: 'approved', headSha: 'a'.repeat(40) });
  });

  it('PR-INTENT cannot mint merge authority from parsed approved records alone', () => {
    const revision = PrRevision.parse({
      id: 'PRREV-1',
      prId: 'PR-1',
      headSha: 'a'.repeat(40),
      ordinal: 1,
      status: 'approved',
      createdAt: nowISO(),
    });
    const approved = PR.parse({
      id: 'PR-1',
      issueId: 'ISSUE-1',
      branch: 'feature',
      generator: 'mock',
      status: 'approved',
      currentRevisionId: revision.id,
      headSha: revision.headSha,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    });
    if (approved.status !== 'approved' || revision.status !== 'approved') {
      throw new Error('fixtures must be approved');
    }
    if (false) {
      // @ts-expect-error parsed persistence records carry no snapshot-derived approval capability
      bindMergeRevisionToPR(approved);
    }
    expect(() => (bindMergeRevisionToPR as unknown as (value: object) => unknown)(approved))
      .toThrow('merge requires an approvePR authorization');
  });

  it('PR-INTENT revision transitions construct a new terminal value with completion evidence', () => {
    const pending = PrRevision.parse({
      id: 'PRREV-1', prId: 'PR-1', headSha: 'a'.repeat(40), ordinal: 1,
      status: 'pending', createdAt: nowISO(),
    });
    // @ts-expect-error terminal revision destinations require completion evidence
    expect(() => transitionPrRevision(pending, { status: 'failed' })).toThrow();
    const failed = transitionPrRevision(pending, {
      status: 'failed', completedAt: nowISO(),
    });
    expect(failed).not.toBe(pending);
    expect(Object.isFrozen(failed)).toBe(true);
    expect(pending.status).toBe('pending');
  });

  it('PR-INTENT makes terminal PR and revision resurrection type-invalid and runtime-invalid', () => {
    const merged = PR.parse({
      id: 'PR-1',
      issueId: 'ISSUE-1',
      branch: 'feature',
      generator: 'mock',
      status: 'merged',
      currentRevisionId: 'PRREV-1',
      headSha: 'a'.repeat(40),
      mergedHeadSha: 'a'.repeat(40),
      createdAt: nowISO(),
      updatedAt: nowISO(),
    });
    if (merged.status !== 'merged') throw new Error('fixture must be merged');
    const closed = PR.parse({
      id: 'PR-2',
      issueId: 'ISSUE-2',
      branch: 'feature/closed',
      generator: 'mock',
      status: 'closed',
      createdAt: nowISO(),
      updatedAt: nowISO(),
    });
    if (closed.status !== 'closed') throw new Error('fixture must be closed');
    if (false) {
      // @ts-expect-error merged PR metadata is terminal history
      updatePR(merged, { attempts: 2 });
      // @ts-expect-error closed PR metadata is terminal history
      updatePR(closed, { externalRef: null });
    }
    const runtimeUpdate = updatePR as unknown as (
      pr: PR,
      patch: { attempts: number },
    ) => PR;
    expect(() => runtimeUpdate(merged, { attempts: 2 }))
      .toThrow('cannot update terminal PR');
    expect(() => runtimeUpdate(closed, { attempts: 2 }))
      .toThrow('cannot update terminal PR');
    expect(() => validatePRTransition(merged, 'open')).toThrow('invalid PR transition');

    const failed = PrRevision.parse({
      id: 'PRREV-1',
      prId: 'PR-1',
      headSha: 'a'.repeat(40),
      ordinal: 1,
      status: 'failed',
      completedAt: nowISO(),
      createdAt: nowISO(),
    });
    if (failed.status !== 'failed') throw new Error('fixture must be failed');
    expect(() => validatePrRevisionTransition(failed, 'reviewing'))
      .toThrow('invalid PR revision transition');
  });

  it('PR-INTENT Store refuses to rewrite persisted terminal PR history', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-terminal-pr-'));
    roots.push(root);
    const store = new Store(root);
    const merged = PR.parse({
      id: 'PR-1',
      issueId: 'ISSUE-1',
      branch: 'feature',
      generator: 'mock',
      status: 'merged',
      currentRevisionId: 'PRREV-1',
      headSha: 'a'.repeat(40),
      mergedHeadSha: 'a'.repeat(40),
      createdAt: nowISO(),
      updatedAt: nowISO(),
    });
    if (merged.status !== 'merged') throw new Error('fixture must be merged');
    store.addPR(merged);
    expect(store.replacePR(merged)).toMatchObject({ status: 'merged', branch: 'feature' });
    const rewritten = PR.parse({ ...merged, branch: 'rewritten' });
    expect(() => store.replacePR(rewritten)).toThrow('cannot replace terminal PR');
  });

  it.each(['merged', 'stale', 'failed'] as const)(
    'PR-INTENT Store permits idempotence but refuses to resurrect a persisted %s revision',
    (status) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentops-terminal-revision-${status}-`));
      roots.push(root);
      const store = new Store(root);
      const terminal = PrRevision.parse({
        id: `PRREV-${status}`,
        prId: 'PR-1',
        headSha: 'a'.repeat(40),
        ordinal: 1,
        status,
        completedAt: nowISO(),
        createdAt: nowISO(),
      });
      store.upsertPrRevision(terminal);

      expect(store.replacePrRevision(terminal)).toMatchObject({ status });
      const resurrected = PrRevision.parse({
        id: terminal.id,
        prId: terminal.prId,
        headSha: terminal.headSha,
        ordinal: terminal.ordinal,
        status: 'reviewing',
        startedAt: nowISO(),
        createdAt: terminal.createdAt,
      });
      expect(() => store.replacePrRevision(resurrected))
        .toThrow('cannot replace terminal PR revision');
    },
  );

  it('PR-INTENT refuses stale, ineligible, or non-current revision approval authority', () => {
    const currentId = 'PRREV-current';
    const sha = PrHeadSha.parse('a'.repeat(40));
    const pr = PR.parse({
      id: 'PR-1', issueId: 'ISSUE-1', branch: 'feature', generator: 'mock',
      currentRevisionId: currentId, headSha: sha,
      createdAt: nowISO(), updatedAt: nowISO(),
    });
    const historical = PrRevision.parse({
      id: 'PRREV-old', prId: pr.id, headSha: 'b'.repeat(40), ordinal: 1,
      status: 'approved', createdAt: nowISO(),
    });
    if (historical.status !== 'approved') throw new Error('fixture must be approved');
    expect(() => bindApprovalRevisionToPR(
      pr,
      historical,
      approvedGate(pr.id, historical.id, historical.headSha),
    )).toThrow('not the current revision');
    const pending = PrRevision.parse({
      id: currentId, prId: pr.id, headSha: sha, ordinal: 2,
      status: 'pending', createdAt: nowISO(),
    });
    expect(() => bindApprovalRevisionToPR(
      pr,
      pending as Parameters<typeof bindApprovalRevisionToPR>[1],
      approvedGate(pr.id, pending.id, pending.headSha),
    )).toThrow('not eligible for approval');
    const rejected = PrRevision.parse({
      id: currentId, prId: pr.id, headSha: sha, ordinal: 2,
      status: 'changes-requested', createdAt: nowISO(),
    });
    expect(() => bindApprovalRevisionToPR(
      pr,
      rejected as Parameters<typeof bindApprovalRevisionToPR>[1],
      approvedGate(pr.id, rejected.id, rejected.headSha),
    )).toThrow('not eligible for approval');
    if (false) {
      // @ts-expect-error a changes-requested revision cannot mint approval authority
      bindApprovalRevisionToPR(pr, rejected, approvedGate(pr.id, rejected.id, rejected.headSha));
    }

    const current = PrRevision.parse({
      id: currentId, prId: pr.id, headSha: sha, ordinal: 2,
      status: 'approved', createdAt: nowISO(),
    });
    if (current.status !== 'approved') throw new Error('fixture must be approved');
    const gate = approvedGate(pr.id, current.id, current.headSha);
    const staleBinding = bindApprovalRevisionToPR(pr, current, gate);
    const mismatchedGate = approvedGate(pr.id, 'PRREV-other', current.headSha);
    expect(() => bindApprovalRevisionToPR(pr, current, mismatchedGate))
      .toThrow('does not match PR revision');
    expect(() => bindApprovalRevisionToPR(
      pr,
      current,
      {
        ...gate,
        decision: 'pending',
        mergeability: 'unknown',
        pendingReasons: ['not ready'],
        reasons: ['not ready'],
      } as unknown as Parameters<typeof bindApprovalRevisionToPR>[2],
    )).toThrow();
    const advanced = transitionPR(pr, {
      status: 'open',
      currentRevisionId: 'PRREV-next',
      headSha: PrHeadSha.parse('c'.repeat(40)),
    });
    expect(() => approvePR(advanced, staleBinding))
      .toThrow('does not match current PR');
    expect(advanced).toMatchObject({
      currentRevisionId: 'PRREV-next',
      headSha: 'c'.repeat(40),
    });
  });

  it('PR-INTENT Store does not return mutable stored lifecycle references', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-lifecycle-'));
    roots.push(root);
    const store = new Store(root);
    const pr = store.addPR(PR.parse({
      id: 'PR-1', issueId: 'ISSUE-1', branch: 'feature', generator: 'mock',
      createdAt: nowISO(), updatedAt: nowISO(),
    }));
    expect(pr).not.toBe(store.db.prs[0]);
    expect(store.getPR('PR-1')).not.toBe(store.db.prs[0]);
    expect(Object.isFrozen(store.getPR('PR-1'))).toBe(true);
    if (false) {
      // @ts-expect-error lifecycle collections are readonly outside Store methods
      store.db.prs.push(pr);
    }
  });

  it('PR-INTENT migrates legacy unbound approvals and gate reasons without trusting them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-lifecycle-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.harness'));
    const legacy = JSON.parse(JSON.stringify(emptyDB())) as {
      prs: Array<Record<string, unknown>>;
      evalRuns: Array<Record<string, unknown>>;
      agentInvocations: Array<Record<string, unknown>>;
      revisionGateSnapshots: Array<Record<string, unknown>>;
    };
    legacy.prs.push({
      id: 'PR-LEGACY',
      issueId: 'ISSUE-LEGACY',
      branch: 'feature/legacy',
      generator: 'mock',
      status: 'approved',
      currentRevisionId: null,
      headSha: null,
      mergedHeadSha: null,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    });
    legacy.evalRuns.push({
      id: 'EVAL-LEGACY',
      issueId: 'ISSUE-LEGACY',
      prId: 'PR-LEGACY',
      attempt: 1,
      sampleIndex: 0,
      agent: 'mock',
      verdict: 'approve',
      hardGates: {},
      findings: [],
      scores: {
        functionality: 1,
        codeQuality: 1,
        testQuality: 1,
        ux: 1,
        accessibility: 1,
      },
      overall: 1,
      cost: {},
      revisionId: 'PRREV-LEGACY',
      headSha: null,
      createdAt: nowISO(),
    });
    legacy.agentInvocations.push({
      id: 'INVOKE-LEGACY',
      invocationKey: 'invocation:legacy',
      subjectId: 'ISSUE-LEGACY',
      issueId: 'ISSUE-LEGACY',
      prId: 'PR-LEGACY',
      sampleIndex: 0,
      attempt: 1,
      role: 'reviewer',
      perspective: 'security',
      provider: 'codex',
      model: null,
      prompt: 'legacy',
      outcome: 'completed',
      revisionId: 'PRREV-LEGACY',
      headSha: null,
      createdAt: nowISO(),
    });
    legacy.revisionGateSnapshots.push({
      id: 'PRGATE-LEGACY',
      prId: 'PR-LEGACY',
      revisionId: 'PRREV-LEGACY',
      headSha: 'a'.repeat(40),
      requiredPerspectives: [],
      perspectiveVerdicts: {},
      checks: [],
      unresolvedBlockingThreadIds: [],
      blockingReviewThreads: [],
      mergeability: 'mergeable',
      decision: 'changes-requested',
      reasons: ['legacy blocker'],
      createdAt: nowISO(),
    });
    fs.writeFileSync(
      path.join(root, '.harness', 'db.json'),
      JSON.stringify(legacy, null, 2) + '\n',
    );

    const store = new Store(root);
    store.save();

    expect(store.db.prs[0]).toMatchObject({
      status: 'open',
      currentRevisionId: null,
      headSha: null,
    });
    expect(store.db.evalRuns[0]).toMatchObject({
      revisionId: null,
      headSha: null,
    });
    expect(store.db.agentInvocations[0]).toMatchObject({
      revisionId: null,
      headSha: null,
    });
    expect(store.db.revisionGateSnapshots[0]).toMatchObject({
      decision: 'changes-requested',
      blockingReasons: ['legacy blocker'],
      pendingReasons: [],
    });
    expect(() => new Store(root)).not.toThrow();
  });

  it('PR-INTENT migrates an unbound pre-revision merged PR to readable fail-closed state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pr-legacy-merged-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    const legacy = emptyDB();
    legacy.prs.push({
      id: 'PR-LEGACY-MERGED',
      issueId: 'ISSUE-LEGACY-MERGED',
      branch: 'feature/legacy-merged',
      generator: 'mock',
      status: 'merged',
      externalRef: null,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    } as never);
    fs.writeFileSync(
      path.join(root, '.harness', 'db.json'),
      JSON.stringify(legacy, null, 2) + '\n',
    );

    const store = new Store(root);
    expect(store.db.prs[0]).toMatchObject({
      status: 'open',
      currentRevisionId: null,
      headSha: null,
      mergedHeadSha: null,
    });
    store.save();
    expect(() => new Store(root)).not.toThrow();
  });
});
