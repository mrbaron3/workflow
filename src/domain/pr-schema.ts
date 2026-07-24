import { z } from 'zod';
import { GeneratorAgent, Verdict } from './agent-runtime.js';

/**
 * The human review gate's external projection, when it has one (ADR-0006 G1). The store is
 * SoT (ADR-0001 / ARCH-execution-009); a GitHub PR is only the UI of the human decision point,
 * so this is a back-reference used to poll that PR's state — never a second source of truth.
 */
export const PrExternalRef = z.object({
  provider: z.literal('github'),
  /** Repository-qualified identity; older persisted rows may omit it. */
  repository: z.string().min(1).optional(),
  number: z.number().int().positive(), // the PR number in the target repo
  url: z.string(),
});
export type PrExternalRef = z.infer<typeof PrExternalRef>;

/** Full immutable Git commit identity used by every PR-revision boundary. */
export const PrHeadSha = z.string()
  .regex(/^[0-9a-f]{40}$/i, 'expected a full 40-character Git commit SHA')
  .brand<'PrHeadSha'>();
export type PrHeadSha = z.infer<typeof PrHeadSha>;

/** Correlated revision evidence: either both coordinates exist or neither does. */
export const RevisionBinding = z.object({
  revisionId: z.string().min(1),
  headSha: PrHeadSha,
});
export type RevisionBinding = DeepReadonly<z.infer<typeof RevisionBinding>>;
const UnboundRevisionCoordinates = z.object({
  revisionId: z.null().default(null),
  headSha: z.null().default(null),
});
export const NullableRevisionCoordinates = z.union([
  RevisionBinding,
  UnboundRevisionCoordinates,
]);

const PRCommon = z.object({
  id: z.string(), // PR-0001
  issueId: z.string(),
  branch: z.string(),
  baseBranch: z.string().default('main'),
  generator: GeneratorAgent,
  /**
   * `issue-pipeline` PRs are created by AgentOps from a Source Issue. `repository-discovery`
   * PRs already existed on GitHub and were imported by repository-wide reconciliation.
   * The latter still receive a synthetic review work unit, but are never individually
   * registered by an operator.
   */
  origin: z.enum(['issue-pipeline', 'repository-discovery']).default('issue-pipeline'),
  /**
   * Last current-head SHA produced and pushed by the trusted AgentOps generator
   * lane. A different observed GitHub head is externally advanced and must not
   * enter the credential-bearing repair lane.
   */
  agentGeneratedHeadSha: PrHeadSha.nullable().default(null),
  attempts: z.number().int().nonnegative().default(0), // generation attempts incl. repairs
  // ADR-0006 G1: set when an approved build is projected to a GitHub PR gate. null = no
  // projection (store-direct gate / local sandbox). Additive — absent on older records.
  externalRef: PrExternalRef.nullable().default(null),
  // ADR-0009: the only revision whose evidence may currently qualify this PR for merge.
  createdAt: z.string(),
  updatedAt: z.string(),
});
const BoundCurrentRevisionFields = {
  currentRevisionId: z.string().min(1),
  headSha: PrHeadSha,
  mergedHeadSha: z.null().default(null),
};
const UnboundCurrentRevisionFields = {
  currentRevisionId: z.null().default(null),
  headSha: z.null().default(null),
  mergedHeadSha: z.null().default(null),
};
const boundOrUnboundRevisionPR = <S extends 'changes-requested' | 'closed'>(status: S) =>
  z.union([
    PRCommon.extend({ status: z.literal(status), ...BoundCurrentRevisionFields }),
    PRCommon.extend({ status: z.literal(status), ...UnboundCurrentRevisionFields }),
  ]);
export const OpenPR = z.union([
  PRCommon.extend({
    status: z.literal('open').default('open'),
    ...BoundCurrentRevisionFields,
  }),
  PRCommon.extend({
    status: z.literal('open').default('open'),
    ...UnboundCurrentRevisionFields,
  }),
]);
export const ChangesRequestedPR = boundOrUnboundRevisionPR('changes-requested');
const ApprovedPRRecord = PRCommon.extend({
  status: z.literal('approved'),
  currentRevisionId: z.string().min(1),
  headSha: PrHeadSha,
  mergedHeadSha: z.null().default(null),
});
export const ClosedPR = boundOrUnboundRevisionPR('closed');
const MergedPRRecord = PRCommon.extend({
  status: z.literal('merged'),
  currentRevisionId: z.string().min(1),
  headSha: PrHeadSha,
  mergedHeadSha: PrHeadSha,
}).refine((pr) => pr.headSha === pr.mergedHeadSha, {
  path: ['mergedHeadSha'],
  message: 'mergedHeadSha must equal headSha',
});
const MergedPRRecordDecoder = MergedPRRecord.brand<'ValidatedMergedPR'>();
/**
 * Runtime constructor for ordinary lifecycle states. Approval and merge are
 * deliberately absent: those states are minted only by pr-lifecycle capabilities.
 */
export const PR = z.union([OpenPR, ChangesRequestedPR, ClosedPR]);
/**
 * Decode-only schema for durable history. Unlike `PR`, this is never a lifecycle
 * constructor; Store writes still require the transition-specific authority.
 */
export const PersistedPRDecoder = z.union([
  OpenPR,
  ChangesRequestedPR,
  ApprovedPRRecord,
  ClosedPR,
  MergedPRRecordDecoder,
]);
export type DeepReadonly<T> =
  T extends string | number | boolean | bigint | symbol | null | undefined ? T :
  T extends (...args: never[]) => unknown ? T :
  T extends readonly (infer U)[] ? readonly DeepReadonly<U>[] :
  T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } :
  T;
export type NonPrivilegedPR = DeepReadonly<z.infer<typeof PR>>;
export type PR = DeepReadonly<z.infer<typeof PersistedPRDecoder>>;
export type ApprovedPR = Extract<PR, { status: 'approved' }>;
export type MergedPR = Extract<PR, { status: 'merged' }>;

/** Decode trusted persisted history without exposing a privileged constructor. */
export function decodePersistedPR(input: unknown): PR {
  return PersistedPRDecoder.parse(input) as PR;
}

export const PrRevisionStatus = z.enum([
  'pending',
  'reviewing',
  'changes-requested',
  'approved',
  'merged',
  'stale',
  'failed',
]);
export type PrRevisionStatus = z.infer<typeof PrRevisionStatus>;

/** Durable identity for exactly one observed GitHub PR head (ADR-0009 / DATA-execution-010). */
const PrRevisionRecord = z.object({
  id: z.string(),
  prId: z.string(),
  headSha: PrHeadSha,
  ordinal: z.number().int().positive(),
  status: PrRevisionStatus.default('pending'),
  mergeRequestedAt: z.string().nullable().default(null),
  createdAt: z.string(),
  completedAt: z.string().nullable().default(null),
});
const RevisionIdentity = PrRevisionRecord.omit({
  status: true, mergeRequestedAt: true, completedAt: true,
});
const ActiveRevisionFields = {
  mergeRequestedAt: z.null().default(null),
  completedAt: z.null().default(null),
};
const PendingPrRevision = RevisionIdentity.extend({
  status: z.literal('pending').default('pending'), ...ActiveRevisionFields,
});
const ReviewingPrRevision = RevisionIdentity.extend({
  status: z.literal('reviewing'), ...ActiveRevisionFields,
});
const ApprovedPrRevision = RevisionIdentity.extend({
  status: z.literal('approved'),
  mergeRequestedAt: z.string().nullable().default(null),
  completedAt: z.null().default(null),
});
const ChangesRequestedPrRevision = RevisionIdentity.extend({
  status: z.literal('changes-requested'),
  ...ActiveRevisionFields,
});
const terminalRevision = <S extends 'stale' | 'failed'>(status: S) =>
  RevisionIdentity.extend({
    status: z.literal(status),
    mergeRequestedAt: z.null().default(null),
    completedAt: z.string(),
  });
const MergedPrRevision = RevisionIdentity.extend({
  status: z.literal('merged'),
  mergeRequestedAt: z.string().nullable().default(null),
  completedAt: z.string(),
});
export const PrRevision = z.discriminatedUnion('status', [
  PendingPrRevision,
  ReviewingPrRevision,
  ChangesRequestedPrRevision,
  ApprovedPrRevision,
  MergedPrRevision,
  terminalRevision('stale'),
  terminalRevision('failed'),
]);
export type PrRevision = DeepReadonly<z.infer<typeof PrRevision>>;

export const RevisionCheck = z.object({
  name: z.string().min(1),
  status: z.enum(['pending', 'success', 'failure']),
});
export type RevisionCheck = z.infer<typeof RevisionCheck>;

export const RevisionReviewThread = z.object({
  id: z.string().min(1),
  body: z.string().min(1),
  path: z.string().nullable().default(null),
  line: z.number().int().positive().nullable().default(null),
});
export type RevisionReviewThread = z.infer<typeof RevisionReviewThread>;

/** One merge-decision fact captured against one immutable head SHA. */
const RevisionGateSnapshotRecord = z.object({
  id: z.string(),
  prId: z.string(),
  revisionId: z.string(),
  headSha: PrHeadSha,
  requiredPerspectives: z.array(z.string()).default([]),
  perspectiveVerdicts: z.record(Verdict).default({}),
  checks: z.array(RevisionCheck).default([]),
  unresolvedBlockingThreadIds: z.array(z.string()).default([]),
  blockingReviewThreads: z.array(RevisionReviewThread).default([]),
  mergeability: z.enum(['mergeable', 'conflicting', 'unknown']),
  decision: z.enum(['pending', 'changes-requested', 'approved']),
  blockingReasons: z.array(z.string()).default([]),
  pendingReasons: z.array(z.string()).default([]),
  /** Legacy display projection; repair logic uses the classified fields above. */
  reasons: z.array(z.string()).default([]),
  createdAt: z.string(),
});
const EmptyReadonlyTuple = z.tuple([]).readonly();
const ApprovedRevisionGateSnapshotRecord = RevisionGateSnapshotRecord.extend({
  decision: z.literal('approved'),
  mergeability: z.literal('mergeable'),
  blockingReasons: EmptyReadonlyTuple.default([]),
  pendingReasons: EmptyReadonlyTuple.default([]),
  unresolvedBlockingThreadIds: EmptyReadonlyTuple.default([]),
  blockingReviewThreads: EmptyReadonlyTuple.default([]),
}).superRefine((snapshot, context) => {
  for (const check of snapshot.checks) {
    if (check.status !== 'success') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checks'],
        message: 'approved snapshots require every check to succeed',
      });
    }
  }
  for (const perspective of snapshot.requiredPerspectives) {
    if (snapshot.perspectiveVerdicts[perspective] !== 'approve') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['perspectiveVerdicts', perspective],
        message: 'approved snapshots require every required perspective to approve',
      });
    }
  }
});
export const ApprovedRevisionGateSnapshot =
  ApprovedRevisionGateSnapshotRecord.brand<'ValidatedApprovedRevisionGateSnapshot'>();
export type ApprovedRevisionGateSnapshot = z.infer<typeof ApprovedRevisionGateSnapshot>;
const PendingRevisionGateSnapshot = RevisionGateSnapshotRecord.extend({
  decision: z.literal('pending'),
  blockingReasons: EmptyReadonlyTuple.default([]),
});
const ChangesRequestedRevisionGateSnapshot = RevisionGateSnapshotRecord.extend({
  decision: z.literal('changes-requested'),
  blockingReasons: z.array(z.string()).min(1),
});
export const RevisionGateSnapshot = z.union([
  PendingRevisionGateSnapshot,
  ChangesRequestedRevisionGateSnapshot,
  ApprovedRevisionGateSnapshotRecord,
]);
export type RevisionGateSnapshot = DeepReadonly<z.infer<typeof RevisionGateSnapshot>>;
