import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptyDB,
  PR,
  PrHeadSha,
  PrRevision,
  RevisionBinding,
  transitionPR,
  transitionPrRevision,
  updatePR,
} from '../src/domain/schema.js';
import { Store, nowISO } from '../src/store/store.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('PR lifecycle values', () => {
  it('PR-INTENT makes PR and revision identity mutations compile-time invalid', () => {
    const open = PR.parse({
      id: 'PR-1', issueId: 'ISSUE-1', branch: 'feature', generator: 'mock',
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
      createdAt: nowISO(), updatedAt: nowISO(),
    });
    const approved = transitionPR(open, {
      status: 'approved',
      currentRevisionId: 'PRREV-1',
      headSha: PrHeadSha.parse('a'.repeat(40)),
    });
    expect(Object.isFrozen(approved)).toBe(true);
    // @ts-expect-error merged destinations require the correlated revision/head identity
    expect(() => transitionPR(approved, {
      status: 'merged',
      mergedHeadSha: PrHeadSha.parse('b'.repeat(40)),
    })).toThrow();
    expect(approved).toMatchObject({ status: 'approved', headSha: 'a'.repeat(40) });
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
    // @ts-expect-error a merged PR has no legal transition destination
    expect(() => transitionPR(merged, { status: 'open' })).toThrow('invalid PR transition');

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
    // @ts-expect-error a failed revision cannot return to reviewing
    expect(() => transitionPrRevision(failed, { status: 'reviewing' }))
      .toThrow('invalid PR revision transition');
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
});
