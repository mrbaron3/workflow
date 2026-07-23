import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PR,
  PrRevision,
  transitionPR,
  transitionPrRevision,
} from '../src/domain/schema.js';
import { Store, nowISO } from '../src/store/store.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('PR lifecycle values', () => {
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
      headSha: 'a'.repeat(40),
    });
    expect(Object.isFrozen(approved)).toBe(true);
    // @ts-expect-error merged destinations require the correlated revision/head identity
    expect(() => transitionPR(approved, {
      status: 'merged',
      mergedHeadSha: 'b'.repeat(40),
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
});
