import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RevisionGateSnapshot } from '../src/domain/schema.js';
import { Store, nowISO } from '../src/store/store.js';
import {
  isSurrogateOracleMismatch,
  surrogateOracleMismatchRevisions,
} from '../src/pipeline/verification-signal.js';

const roots: string[] = [];
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
    checks: [{ name: 'test', status: 'failure' }],
    unresolvedBlockingThreadIds: [],
    mergeability: 'mergeable',
    decision: 'changes-requested',
    blockingReasons: ['required check failed: test'],
    pendingReasons: [],
    reasons: ['required check failed: test'],
    createdAt: nowISO(),
    ...overrides,
  });
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('surrogate verifier calibration signal', () => {
  it('classifies all-proxy-approved plus independent required-check failure as a mismatch', () => {
    expect(isSurrogateOracleMismatch(snapshot())).toBe(true);
  });

  it('does not call an already-caught finding or an operational conflict an oracle mismatch', () => {
    expect(isSurrogateOracleMismatch(snapshot({
      perspectiveVerdicts: {
        functionality: 'approve',
        security: 'request_changes',
      },
      blockingReasons: [
        'security verdict is request_changes',
        'required check failed: test',
      ],
      reasons: [
        'security verdict is request_changes',
        'required check failed: test',
      ],
    }))).toBe(false);

    expect(isSurrogateOracleMismatch(snapshot({
      checks: [{ name: 'test', status: 'success' }],
      mergeability: 'conflicting',
      blockingReasons: ['pull request has merge conflicts'],
      reasons: ['pull request has merge conflicts'],
    }))).toBe(false);
  });

  it('counts each rejected revision once even when reconciliation persisted repeated snapshots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-verifier-signal-'));
    roots.push(root);
    const store = new Store(root);
    store.db.revisionGateSnapshots.push(
      snapshot(),
      snapshot({
        id: 'PRGATE-0002',
        createdAt: new Date(Date.now() + 1).toISOString(),
      }),
      snapshot({
        id: 'PRGATE-0003',
        revisionId: 'PRREV-0002',
        headSha: SHA_B,
        checks: [{ name: 'test', status: 'success' }],
        blockingReasons: ['unresolved blocking review thread: P1'],
        unresolvedBlockingThreadIds: ['P1'],
        reasons: ['unresolved blocking review thread: P1'],
      }),
      snapshot({
        id: 'PRGATE-0004',
        prId: 'PR-OTHER',
        revisionId: 'PRREV-OTHER',
      }),
    );

    expect(surrogateOracleMismatchRevisions(store, 'PR-0001')).toEqual([
      'PRREV-0001',
      'PRREV-0002',
    ]);
  });
});
