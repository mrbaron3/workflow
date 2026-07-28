import { describe, expect, it } from 'vitest';
import { RevisionGateSnapshot } from '../src/domain/schema.js';
import {
  isSurrogateOracleMismatch,
  surrogateOracleMismatchRevisions,
} from '../src/pipeline/verification-signal.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function snapshot(overrides: Record<string, unknown> = {}) {
  return RevisionGateSnapshot.parse({
    id: 'PRGATE-0001',
    prId: 'PR-0001',
    revisionId: 'PRREV-0001',
    headSha: SHA_A,
    requiredPerspectives: ['functionality', 'security'],
    perspectiveVerdicts: {
      functionality: 'approve',
      security: 'approve',
    },
    checks: [{ name: 'external-test', status: 'failure' }],
    unresolvedBlockingThreadIds: [],
    blockingReviewThreads: [],
    mergeability: 'mergeable',
    decision: 'changes-requested',
    blockingReasons: ['required check failed: external-test'],
    pendingReasons: [],
    reasons: ['required check failed: external-test'],
    createdAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  });
}

describe('surrogate verifier calibration signal', () => {
  it('classifies all-perspective approval plus an independent check or blocking review rejection', () => {
    expect(isSurrogateOracleMismatch(snapshot())).toBe(true);
    expect(isSurrogateOracleMismatch(snapshot({
      checks: [{ name: 'external-test', status: 'success' }],
      unresolvedBlockingThreadIds: ['PRRT-P1'],
      blockingReviewThreads: [{
        id: 'PRRT-P1',
        body: 'private oracle detail',
        path: 'src/example.ts',
        line: 12,
      }],
      blockingReasons: ['unresolved blocking review thread: PRRT-P1'],
      reasons: ['unresolved blocking review thread: PRRT-P1'],
    }))).toBe(true);
  });

  it('does not classify an internally caught defect or an operational conflict as a mismatch', () => {
    expect(isSurrogateOracleMismatch(snapshot({
      perspectiveVerdicts: {
        functionality: 'approve',
        security: 'request_changes',
      },
      blockingReasons: [
        'security verdict is request_changes',
        'required check failed: external-test',
      ],
      reasons: [
        'security verdict is request_changes',
        'required check failed: external-test',
      ],
    }))).toBe(false);

    expect(isSurrogateOracleMismatch(snapshot({
      checks: [{ name: 'external-test', status: 'success' }],
      mergeability: 'conflicting',
      blockingReasons: ['pull request has merge conflicts'],
      reasons: ['pull request has merge conflicts'],
    }))).toBe(false);
  });

  it('counts each rejected revision once even when reconciliation persisted repeated snapshots', () => {
    const snapshots = [
      snapshot(),
      snapshot({
        id: 'PRGATE-0002',
        createdAt: '2026-07-28T00:00:01.000Z',
      }),
      snapshot({
        id: 'PRGATE-0003',
        revisionId: 'PRREV-0002',
        headSha: SHA_B,
        checks: [{ name: 'external-test', status: 'success' }],
        unresolvedBlockingThreadIds: ['PRRT-P1'],
        blockingReviewThreads: [{
          id: 'PRRT-P1',
          body: 'private oracle detail',
          path: null,
          line: null,
        }],
        blockingReasons: ['unresolved blocking review thread: PRRT-P1'],
        reasons: ['unresolved blocking review thread: PRRT-P1'],
      }),
      snapshot({
        id: 'PRGATE-0004',
        prId: 'PR-OTHER',
        revisionId: 'PRREV-OTHER',
      }),
    ];

    expect(surrogateOracleMismatchRevisions(snapshots, 'PR-0001')).toEqual([
      'PRREV-0001',
      'PRREV-0002',
    ]);
  });
});
