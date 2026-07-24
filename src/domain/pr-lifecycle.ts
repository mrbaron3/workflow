import {
  ApprovedRevisionGateSnapshot,
  ApprovedPR,
  PR,
  PrRevision,
  createMergedPR,
  type DeepReadonly,
  type MergedPR,
  type PrHeadSha,
  type RevisionBinding,
} from './pr-schema.js';

/** State transitions and opaque approval/merge authorities for immutable PR revisions. */
type MutablePR = Exclude<PR, { status: 'closed' | 'merged' }>;
type PRPatch = Partial<Pick<
  MutablePR,
  'branch' | 'baseBranch' | 'attempts' | 'externalRef'
>>;
type RevisionCoordinateDestinationFields =
  | { currentRevisionId: string; headSha: PrHeadSha; mergedHeadSha?: null }
  | { currentRevisionId?: null; headSha?: null; mergedHeadSha?: null };
type OpenPRDestination =
  PRPatch & RevisionCoordinateDestinationFields & { status: 'open' };
type ChangesRequestedPRDestination =
  PRPatch & RevisionCoordinateDestinationFields & { status: 'changes-requested' };
type ClosedPRDestination =
  PRPatch & RevisionCoordinateDestinationFields & { status: 'closed' };
export type PRTransitionDestination =
  | OpenPRDestination
  | ChangesRequestedPRDestination
  | ClosedPRDestination;
const PR_TRANSITIONS = {
  open: { open: true, 'changes-requested': true, closed: true },
  'changes-requested': { open: true, 'changes-requested': true, closed: true },
  approved: { open: true, 'changes-requested': true, closed: true },
  closed: {},
  merged: {},
} as const satisfies Readonly<Record<PR['status'], Readonly<Partial<
  Record<PRTransitionDestination['status'], true>
>>>>;
type PRTransitionStatusFor<S extends PR['status']> =
  S extends PR['status'] ? keyof typeof PR_TRANSITIONS[S] : never;
type PRTransitionFor<S extends PR['status']> = Extract<
  PRTransitionDestination,
  { status: PRTransitionStatusFor<S> }
>;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export function transitionPR<
  S extends PR['status'],
  D extends PRTransitionFor<S>,
>(
  pr: Extract<PR, { status: S }>,
  destination: D & Record<
    Exclude<keyof D, keyof Extract<PRTransitionFor<S>, { status: D['status'] }>>,
    never
  >,
): Extract<PR, { status: D['status'] }> {
  validatePRTransition(pr, destination.status);
  const normalized = { mergedHeadSha: null, ...destination };
  return deepFreeze(PR.parse({
    ...pr,
    ...normalized,
    updatedAt: new Date().toISOString(),
  })) as Extract<PR, { status: D['status'] }>;
}

/** Runtime seam for data whose destination status was not statically known. */
export function validatePRTransition(pr: PR, destinationStatus: string): void {
  if (!Object.hasOwn(PR_TRANSITIONS[pr.status], destinationStatus)) {
    throw new Error(`invalid PR transition: ${pr.status} -> ${destinationStatus}`);
  }
}

declare const approvalRevisionBrand: unique symbol;
export type ApprovalRevisionBinding = RevisionBinding & {
  readonly prId: string;
  readonly gateSnapshotId: string;
  readonly [approvalRevisionBrand]: true;
};
declare const mergeRevisionBrand: unique symbol;
export type MergeRevisionBinding = RevisionBinding & {
  readonly prId: string;
  readonly [mergeRevisionBrand]: true;
};
export type ApprovalEligiblePrRevision = Extract<
  PrRevision,
  { status: 'approved' }
>;
/**
 * Approval authority is minted only from a schema-validated successful gate for
 * the exact current, approved revision. A panel verdict or revision status alone
 * is deliberately insufficient.
 */
export function bindApprovalRevisionToPR(
  pr: PR,
  revision: ApprovalEligiblePrRevision,
  snapshot: ApprovedRevisionGateSnapshot,
): ApprovalRevisionBinding;
export function bindApprovalRevisionToPR(
  pr: PR,
  revision: PrRevision,
  snapshot: ApprovedRevisionGateSnapshot,
): ApprovalRevisionBinding {
  if (revision.status !== 'approved') {
    throw new Error(`revision ${revision.id} (${revision.status}) is not eligible for approval`);
  }
  const validatedSnapshot = ApprovedRevisionGateSnapshot.parse(snapshot);
  if (
    validatedSnapshot.prId !== pr.id
    || validatedSnapshot.revisionId !== revision.id
    || validatedSnapshot.headSha !== revision.headSha
  ) {
    throw new Error(
      `approved gate snapshot ${validatedSnapshot.id} does not match PR revision ${revision.id}`,
    );
  }
  if (revision.prId !== pr.id) {
    throw new Error(`revision ${revision.id} does not belong to PR ${pr.id}`);
  }
  if (revision.id !== pr.currentRevisionId || revision.headSha !== pr.headSha) {
    throw new Error(`revision ${revision.id} is not the current revision of PR ${pr.id}`);
  }
  return Object.freeze({
    prId: pr.id,
    revisionId: revision.id,
    headSha: revision.headSha,
    gateSnapshotId: validatedSnapshot.id,
  }) as ApprovalRevisionBinding;
}

/** Merge authority is deliberately distinct from review approval authority. */
export function bindMergeRevisionToPR(
  pr: Extract<PR, { status: 'approved' }>,
  revision: Extract<PrRevision, { status: 'approved' }>,
): MergeRevisionBinding {
  if (
    revision.prId !== pr.id
    || revision.id !== pr.currentRevisionId
    || revision.headSha !== pr.headSha
  ) {
    throw new Error(`approved revision ${revision.id} is not current for PR ${pr.id}`);
  }
  return Object.freeze({
    prId: pr.id,
    revisionId: revision.id,
    headSha: revision.headSha,
  }) as MergeRevisionBinding;
}

export function approvePR(
  pr: PR,
  binding: ApprovalRevisionBinding,
): Extract<PR, { status: 'approved' }> {
  if (pr.status === 'closed' || pr.status === 'merged') {
    throw new Error(`cannot approve terminal PR ${pr.id} (${pr.status})`);
  }
  if (
    binding.prId !== pr.id
    || binding.revisionId !== pr.currentRevisionId
    || binding.headSha !== pr.headSha
  ) {
    throw new Error(`approval revision binding does not match current PR ${pr.id}`);
  }
  return deepFreeze(ApprovedPR.parse({
    ...pr,
    status: 'approved',
    currentRevisionId: binding.revisionId,
    headSha: binding.headSha,
    mergedHeadSha: null,
    updatedAt: new Date().toISOString(),
  }));
}

export function mergeApprovedPR(
  pr: Extract<PR, { status: 'approved' }>,
  binding: MergeRevisionBinding,
): MergedPR {
  if (
    binding.prId !== pr.id
    || binding.revisionId !== pr.currentRevisionId
    || binding.headSha !== pr.headSha
  ) {
    throw new Error(`approved revision binding does not match PR ${pr.id}`);
  }
  return deepFreeze(createMergedPR({
    ...pr,
    status: 'merged',
    currentRevisionId: binding.revisionId,
    headSha: binding.headSha,
    mergedHeadSha: binding.headSha,
    updatedAt: new Date().toISOString(),
  }));
}

/** Narrow an intentionally dynamic PR before applying non-terminal metadata changes. */
export function requireMutablePR(pr: PR): MutablePR {
  if (pr.status === 'closed' || pr.status === 'merged') {
    throw new Error(`cannot update terminal PR ${pr.id} (${pr.status})`);
  }
  return pr;
}

/** Update explicitly mutable metadata on a non-terminal PR. */
export function updatePR<const T extends MutablePR, const P>(
  pr: T,
  patch: P & PRPatch & Record<Exclude<keyof P, keyof PRPatch>, never>,
): T {
  requireMutablePR(pr as PR);
  return deepFreeze(
    PR.parse({ ...pr, ...patch, updatedAt: new Date().toISOString() }),
  ) as T;
}

type ReviewingRevisionDestination =
  { status: 'reviewing'; mergeRequestedAt?: null; completedAt?: null };
type ChangesRequestedRevisionDestination =
  { status: 'changes-requested'; mergeRequestedAt?: null; completedAt?: null };
type ApprovedRevisionDestination =
  { status: 'approved'; mergeRequestedAt?: string | null; completedAt?: null };
type MergedRevisionDestination =
  { status: 'merged'; mergeRequestedAt?: string | null; completedAt: string };
type StaleRevisionDestination =
  { status: 'stale'; mergeRequestedAt?: null; completedAt: string };
type FailedRevisionDestination =
  { status: 'failed'; mergeRequestedAt?: null; completedAt: string };
export type PrRevisionTransitionDestination =
  | ReviewingRevisionDestination
  | ChangesRequestedRevisionDestination
  | ApprovedRevisionDestination
  | MergedRevisionDestination
  | StaleRevisionDestination
  | FailedRevisionDestination;
const PR_REVISION_TRANSITIONS = {
  pending: { reviewing: true, stale: true, failed: true },
  reviewing: {
    reviewing: true, 'changes-requested': true, approved: true, stale: true, failed: true,
  },
  'changes-requested': {
    reviewing: true, 'changes-requested': true, approved: true, stale: true, failed: true,
  },
  approved: {
    reviewing: true,
    'changes-requested': true,
    approved: true,
    merged: true,
    stale: true,
    failed: true,
  },
  merged: {},
  stale: {},
  failed: {},
} as const satisfies Readonly<Record<PrRevision['status'], Readonly<Partial<
  Record<PrRevisionTransitionDestination['status'], true>
>>>>;
type PrRevisionTransitionStatusFor<S extends PrRevision['status']> =
  S extends PrRevision['status'] ? keyof typeof PR_REVISION_TRANSITIONS[S] : never;
type DerivedPrRevisionTransitionFor<S extends PrRevision['status']> = Extract<
  PrRevisionTransitionDestination,
  { status: PrRevisionTransitionStatusFor<S> }
>;

export function transitionPrRevision<
  S extends PrRevision['status'],
  D extends DerivedPrRevisionTransitionFor<S>,
>(
  revision: Extract<PrRevision, { status: S }>,
  destination: D & Record<
    Exclude<keyof D, keyof Extract<DerivedPrRevisionTransitionFor<S>, { status: D['status'] }>>,
    never
  >,
): Extract<PrRevision, { status: D['status'] }> {
  validatePrRevisionTransition(revision, destination.status);
  const normalized = destination.status === 'merged'
    ? destination
    : destination.status === 'approved'
      ? { completedAt: null, ...destination }
      : { mergeRequestedAt: null, completedAt: null, ...destination };
  return deepFreeze(PrRevision.parse({
    ...revision,
    ...normalized,
  })) as Extract<PrRevision, { status: D['status'] }>;
}

/** Runtime seam for persisted or otherwise intentionally unknown revision transitions. */
export function validatePrRevisionTransition(
  revision: PrRevision,
  destinationStatus: string,
): void {
  if (!Object.hasOwn(PR_REVISION_TRANSITIONS[revision.status], destinationStatus)) {
    throw new Error(
      `invalid PR revision transition: ${revision.status} -> ${destinationStatus}`,
    );
  }
}

export function stalePrRevision(
  revision: Exclude<PrRevision, { status: 'merged' | 'stale' | 'failed' }>,
  completedAt: string,
): Extract<PrRevision, { status: 'stale' }> {
  return transitionPrRevision(revision, {
    status: 'stale',
    mergeRequestedAt: null,
    completedAt,
  }) as Extract<PrRevision, { status: 'stale' }>;
}
