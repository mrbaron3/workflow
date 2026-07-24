import {
  ApprovedRevisionGateSnapshot,
  RevisionGateSnapshot,
  type DeepReadonly,
  type PR,
  type PrRevision,
  type RevisionCheck,
  type RevisionReviewThread,
} from './pr-schema.js';

const evaluatedRevisionGateBrand: unique symbol = Symbol('EvaluatedRevisionGateSnapshot');
type EvaluatedRevisionGateBrand = {
  readonly [evaluatedRevisionGateBrand]: true;
};
export type EvaluatedRevisionGateSnapshot =
  | (Extract<RevisionGateSnapshot, { decision: 'pending' }> & EvaluatedRevisionGateBrand)
  | (Extract<RevisionGateSnapshot, { decision: 'changes-requested' }> & EvaluatedRevisionGateBrand)
  | (ApprovedRevisionGateSnapshot & EvaluatedRevisionGateBrand);
export type EvaluatedApprovedRevisionGateSnapshot = Extract<
  EvaluatedRevisionGateSnapshot,
  { decision: 'approved' }
>;

export interface RevisionGateReviewRunEvidence {
  perspective: string | null;
  verdict: 'approve' | 'request_changes' | 'needs_human';
  findings: ReadonlyArray<{
    criterionId: string;
    severity: 'blocker' | 'major' | 'minor';
  }>;
}

export interface RevisionGateGithubEvidence {
  state: 'open' | 'merged' | 'closed';
  headSha: string;
  isDraft: boolean;
  mergeability: 'mergeable' | 'conflicting' | 'unknown';
  checks: RevisionCheck[];
  unresolvedBlockingThreadIds: string[];
  blockingReviewThreads?: RevisionReviewThread[];
}

export interface RevisionGateEvaluationEvidence {
  id: string;
  pr: PR;
  revision: PrRevision;
  requiredPerspectives: string[];
  reviewRuns: RevisionGateReviewRunEvidence[];
  github: RevisionGateGithubEvidence;
  requiredChecks?: string[];
  createdAt: string;
}

export const MAX_REVIEW_THREAD_REASON_BODY_CHARS = 500;

function deepFreezeGate<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreezeGate(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function selectedRevisionChecks(
  observed: RevisionCheck[],
  required: string[] | undefined,
): RevisionCheck[] {
  if (!required || required.length === 0) return observed;
  return [...new Set(required)].map((name) => {
    const matches = observed.filter((check) => check.name === name);
    if (matches.some((check) => check.status === 'failure')) return { name, status: 'failure' };
    if (matches.length === 0 || matches.some((check) => check.status === 'pending')) {
      return { name, status: 'pending' };
    }
    return { name, status: 'success' };
  });
}

/**
 * The sole runtime mint for gate authority. Callers provide observable evidence,
 * never a decision; this function derives the decision and attaches a symbol that
 * schema parsing and persisted JSON cannot recreate.
 */
export function evaluateRevisionGateEvidence(
  input: RevisionGateEvaluationEvidence,
): EvaluatedRevisionGateSnapshot {
  if (
    input.revision.prId !== input.pr.id
    || input.pr.currentRevisionId !== input.revision.id
    || input.pr.headSha !== input.revision.headSha
  ) {
    throw new Error(`gate evidence does not match current PR revision ${input.revision.id}`);
  }
  const perspectiveVerdicts: Record<
    string,
    RevisionGateReviewRunEvidence['verdict']
  > = {};
  const blockingReasons: string[] = [];
  const pendingReasons: string[] = [];

  if (input.revision.status === 'stale') {
    blockingReasons.push('revision was invalidated by a later head');
  }
  for (const perspective of new Set(input.requiredPerspectives)) {
    const perspectiveRuns = input.reviewRuns.filter(
      (candidate) => candidate.perspective === perspective,
    );
    if (perspectiveRuns.length === 0) {
      pendingReasons.push(`missing review: ${perspective}`);
      continue;
    }
    const verdict = perspectiveRuns.some((run) => run.verdict === 'needs_human')
      ? 'needs_human'
      : perspectiveRuns.some((run) => run.verdict === 'request_changes')
        ? 'request_changes'
        : 'approve';
    perspectiveVerdicts[perspective] = verdict;
    if (verdict !== 'approve') {
      blockingReasons.push(`${perspective} verdict is ${verdict}`);
    }
    for (const run of perspectiveRuns) {
      for (const finding of run.findings) {
        if (finding.severity === 'blocker' || finding.severity === 'major') {
          blockingReasons.push(
            `${perspective} has unresolved ${finding.severity} finding ${finding.criterionId}`,
          );
        }
      }
    }
  }

  const checks = selectedRevisionChecks(input.github.checks, input.requiredChecks);
  for (const check of checks) {
    if (check.status === 'failure') blockingReasons.push(`required check failed: ${check.name}`);
    if (check.status === 'pending') pendingReasons.push(`required check pending: ${check.name}`);
  }
  for (const threadId of input.github.unresolvedBlockingThreadIds) {
    const thread = input.github.blockingReviewThreads?.find(
      (candidate) => candidate.id === threadId,
    );
    blockingReasons.push(
      `unresolved blocking review thread: ${threadId}`
      + (thread ? ` — ${thread.body.slice(0, MAX_REVIEW_THREAD_REASON_BODY_CHARS)}` : ''),
    );
  }
  if (input.github.mergeability === 'conflicting') {
    blockingReasons.push('pull request has merge conflicts');
  } else if (input.github.mergeability === 'unknown') {
    pendingReasons.push('mergeability is unknown');
  }
  if (input.github.isDraft) pendingReasons.push('pull request is draft');
  if (input.github.state !== 'open') {
    blockingReasons.push(`pull request state is ${input.github.state}`);
  }
  if (input.github.headSha !== input.revision.headSha) {
    blockingReasons.push(
      `head changed from ${input.revision.headSha} to ${input.github.headSha}`,
    );
  }

  const decision = blockingReasons.length > 0
    ? 'changes-requested'
    : pendingReasons.length > 0
      ? 'pending'
      : 'approved';
  const parsed = RevisionGateSnapshot.parse({
    id: input.id,
    prId: input.pr.id,
    revisionId: input.revision.id,
    headSha: input.revision.headSha,
    requiredPerspectives: input.requiredPerspectives,
    perspectiveVerdicts,
    checks,
    unresolvedBlockingThreadIds: input.github.unresolvedBlockingThreadIds,
    blockingReviewThreads: input.github.blockingReviewThreads ?? [],
    mergeability: input.github.mergeability,
    decision,
    blockingReasons,
    pendingReasons,
    reasons: [...blockingReasons, ...pendingReasons],
    createdAt: input.createdAt,
  });
  const validated = parsed.decision === 'approved'
    ? ApprovedRevisionGateSnapshot.parse(parsed)
    : parsed;
  return deepFreezeGate({
    ...validated,
    [evaluatedRevisionGateBrand]: true as const,
  }) as EvaluatedRevisionGateSnapshot;
}

export function isEvaluatedRevisionGateSnapshot(
  snapshot: unknown,
): snapshot is EvaluatedRevisionGateSnapshot {
  return Boolean(
    snapshot
    && typeof snapshot === 'object'
    && (snapshot as Partial<EvaluatedRevisionGateBrand>)[evaluatedRevisionGateBrand] === true,
  );
}
