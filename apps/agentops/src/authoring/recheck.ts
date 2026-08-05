/**
 * Two-stage drift re-check for a signed spec (M20 AUTH-D): given the immutable
 * ApprovedSpecRef pinned at signing and the spec's current files, decide what (if
 * anything) drifted and what status the spec now derives to.
 *
 *   stage ① coarse  : compare pinned blob SHAs vs the working-tree blob SHAs.
 *                     Unchanged -> still fully approved, skip the expensive diff.
 *   stage ② AC diff : recompute per-AC fingerprints and run evaluateDrift, so a
 *                     changed/added AC drops status to co-authoring and a deleted
 *                     AC is pruned while the rest stay approved.
 *
 * The ApprovedSpecRef is NEVER mutated here — it is the audit pin (signed commit +
 * blob SHAs). Status is always derived fresh (AC-AUTH-008); re-signing means
 * running `sign` again at the new commit. Git I/O (the blob SHAs) is the caller's.
 */

import type { ApprovedSpecRef } from '../domain/schema.js';
import { parseSpecScenarios, parseAcceptance } from './source.js';
import { computeAcFingerprints } from './sign.js';
import { evaluateDrift, type DriftResult } from './drift.js';

export interface RecheckInput {
  approved: ApprovedSpecRef;
  specText: string;
  acceptanceText: string;
  /** Working-tree blob SHA of spec.md (`git hash-object`) — the coarse-stage signal. */
  currentSpecBlobSha: string;
  /** Working-tree blob SHA of acceptance.yaml. */
  currentAcceptanceBlobSha: string;
}

export interface RecheckResult extends DriftResult {
  /** stage ①: did the coarse blob-SHA check see any change since signing? */
  coarseChanged: boolean;
}

export function recheckSpec(input: RecheckInput): RecheckResult {
  const coarseChanged =
    input.approved.specBlobGitSha !== input.currentSpecBlobSha ||
    input.approved.acceptanceBlobGitSha !== input.currentAcceptanceBlobSha;

  // Stage ①: identical blobs => content is byte-for-byte the signed content, so
  // the signed AC set still fully covers the current one. No need to parse/hash.
  if (!coarseChanged) {
    return {
      coarseChanged: false,
      changed: [],
      added: [],
      removed: [],
      retainedApprovedAcIds: input.approved.approvedAcIds,
      status: 'approved',
    };
  }

  // Stage ②: something moved — diff at AC granularity and derive the new status.
  const scenarios = parseSpecScenarios(input.specText);
  const verifications = parseAcceptance(input.acceptanceText);
  const current = {
    acIds: scenarios.map((s) => s.id),
    fingerprints: computeAcFingerprints(scenarios, verifications),
  };
  const drift = evaluateDrift(
    { approvedAcIds: input.approved.approvedAcIds, fingerprints: input.approved.acFingerprints },
    current,
  );
  return { coarseChanged: true, ...drift };
}
