/**
 * Co-evolutionary calibration signal for the evaluator panel.
 *
 * The perspective panel is a dense, actionable surrogate verifier. Required
 * GitHub checks and external blocking reviews are an independent, sparse
 * oracle: they can reject a revision without becoming the panel's answer key.
 * When every required perspective approved but that oracle rejected, the gap
 * is evidence that the surrogate's coverage was incomplete.
 *
 * Only the opaque mismatch count is fed into later reviewer sessions. Detailed
 * gate reasons remain available to the repair path, but are deliberately not
 * copied into this signal, which prevents a reviewer from fitting itself to a
 * hidden check's contents.
 */

import type { RevisionGateSnapshot } from '../domain/schema.js';

export function isSurrogateOracleMismatch(
  snapshot: RevisionGateSnapshot,
): boolean {
  if (snapshot.requiredPerspectives.length === 0) return false;
  const surrogateApproved = snapshot.requiredPerspectives.every(
    (perspective) => snapshot.perspectiveVerdicts[perspective] === 'approve',
  );
  if (!surrogateApproved) return false;

  return snapshot.checks.some((check) => check.status === 'failure')
    || snapshot.unresolvedBlockingThreadIds.length > 0;
}

/**
 * Return mismatching revisions in first-observed order. Reconciliation may
 * persist more than one gate snapshot for a revision; one revision contributes
 * one calibration event so polling frequency cannot amplify the signal.
 */
export function surrogateOracleMismatchRevisions(
  snapshots: readonly RevisionGateSnapshot[],
  prId?: string,
): string[] {
  const revisions = new Set<string>();
  for (const snapshot of snapshots) {
    if (prId !== undefined && snapshot.prId !== prId) continue;
    if (isSurrogateOracleMismatch(snapshot)) revisions.add(snapshot.revisionId);
  }
  return [...revisions];
}
