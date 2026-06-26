/**
 * Post-signing coherence for the authoring layer (M20): once a spec is signed,
 * its approval must stay HONEST as the contract keeps being edited. Two concerns:
 *
 *   - status derivation (AC-AUTH-008): `approved` is never hand-written — it is
 *     derived from whether the signed approvedAcIds still cover the current AC set.
 *   - AC-level drift (AC-AUTH-009/010/011): an AC whose *content* changed after
 *     signing must lose its signature WITHOUT dragging unrelated ACs down with it.
 *
 * These are pure functions over already-resolved data (AC-IDs + fingerprints).
 * The coarse git blob-SHA pre-check, persistence of ApprovedSpecRef, and the
 * design-layer orphan link are the store-/git-bound half (M20 B-track) that wraps
 * around this core. See src/authoring/fingerprint.ts for the AC content hash.
 */

// status vocabulary lives with the other domain states; re-exported for callers
// that work purely against this module.
import { SPEC_STATUSES, type SpecStatus } from '../domain/states.js';
export { SPEC_STATUSES, type SpecStatus };

/**
 * AC-AUTH-008: status is a derived aggregate, never written directly. `approved`
 * iff the signed approvedAcIds cover every current AC-ID (approvedAcIds ⊇ current);
 * any shortfall derives `co-authoring`. Extra approved IDs beyond the current set
 * (e.g. a since-deleted AC not yet pruned) do not break coverage.
 */
export function deriveStatus(approvedAcIds: Iterable<string>, currentAcIds: Iterable<string>): SpecStatus {
  const approved = new Set(approvedAcIds);
  for (const id of currentAcIds) {
    if (!approved.has(id)) return 'co-authoring';
  }
  return 'approved';
}

export interface AcDiff {
  /** In both, but the content fingerprint differs — signed meaning changed (AC-AUTH-009). */
  changed: string[];
  /** Present now, absent at signing — a newly added AC (AC-AUTH-010). */
  added: string[];
  /** Present at signing, absent now — a deleted AC (AC-AUTH-011). */
  removed: string[];
}

/**
 * AC-level structural diff: compare the fingerprints pinned at signing (`approved`)
 * against the fingerprints recomputed from the current contract (`current`). Pure
 * over AC-ID -> fingerprint maps; coverage of the AC-ID *set* is the (changed-blind)
 * job of checkCoverage in ./lint.ts — this one sees through identical IDs to content.
 */
export function diffApprovedAcs(
  current: Record<string, string>,
  approved: Record<string, string>,
): AcDiff {
  const changed: string[] = [];
  const added: string[] = [];
  for (const [id, fp] of Object.entries(current)) {
    if (!(id in approved)) added.push(id);
    else if (approved[id] !== fp) changed.push(id);
  }
  const removed = Object.keys(approved).filter((id) => !(id in current));
  return { changed, added, removed };
}

export interface ApprovedSnapshot {
  /** AC-IDs that carried a valid signature (ApprovedSpecRef.approvedAcIds). */
  approvedAcIds: string[];
  /** AC-ID -> content fingerprint pinned at signing (ApprovedSpecRef.acFingerprints). */
  fingerprints: Record<string, string>;
}

export interface CurrentSnapshot {
  /** AC-IDs in the contract right now. */
  acIds: string[];
  /** AC-ID -> content fingerprint recomputed from the current contract. */
  fingerprints: Record<string, string>;
}

export interface DriftResult extends AcDiff {
  /** approvedAcIds that survive: still signed, content unchanged, not deleted. */
  retainedApprovedAcIds: string[];
  /** Status derived after applying the drift (the AC-AUTH-009/010/011 outcome). */
  status: SpecStatus;
}

/**
 * Compose the two primitives the way AUTH-D requires: a changed or removed AC
 * loses its signature, every untouched AC is retained, and the resulting status is
 * *derived* (never written). This is the pure core of the B-track drift gate — the
 * git coarse-check, ApprovedSpecRef persistence, and orphan link wrap around it.
 *
 *   - one AC edited   -> changed=[that];  retained drops it; still in current -> co-authoring
 *   - one AC added    -> added=[new];     retained unchanged; new uncovered    -> co-authoring
 *   - one AC deleted  -> removed=[gone];  retained drops it; remainder covered -> approved
 */
export function evaluateDrift(approved: ApprovedSnapshot, current: CurrentSnapshot): DriftResult {
  const diff = diffApprovedAcs(current.fingerprints, approved.fingerprints);
  const invalidated = new Set([...diff.changed, ...diff.removed]);
  const retainedApprovedAcIds = approved.approvedAcIds.filter((id) => !invalidated.has(id));
  return { ...diff, retainedApprovedAcIds, status: deriveStatus(retainedApprovedAcIds, current.acIds) };
}
