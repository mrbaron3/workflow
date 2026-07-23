import type { HarnessConfig } from '../../config.js';
import {
  PrRevision,
  PrHeadSha,
  ApprovedRevisionGateSnapshot,
  RevisionGateSnapshot,
  approvePR,
  bindApprovalRevisionToPR,
  bindMergeRevisionToPR,
  mergeApprovedPR,
  stalePrRevision,
  transitionPR,
  transitionPrRevision,
  type EvalRun,
  type PR,
  type RevisionCheck,
  type RevisionReviewThread,
  type RevisionGateSnapshot as RevisionGateSnapshotType,
} from '../../domain/schema.js';
import { Store, nowISO } from '../../store/store.js';
export {
  BLOCKING_REVIEW_COMMENT,
  GhPrListResponse,
  GhPrViewResponse,
  MAX_REVIEW_THREAD_BODY_CHARS,
  ReviewThreadsResponse,
  parseBlockingReviewThreads,
  realPrNativeGithubRunner,
} from './pr-native-github.js';

export interface GithubPrRevisionState {
  state: 'open' | 'merged' | 'closed';
  headSha: string;
  isDraft?: boolean;
  mergeability: 'mergeable' | 'conflicting' | 'unknown';
  checks: RevisionCheck[];
  unresolvedBlockingThreadIds: string[];
  blockingReviewThreads?: RevisionReviewThread[];
}
export interface GithubOpenPullRequest {
  number: number;
  url: string;
  title: string;
  body: string;
  headRefName: string;
  headSha: string;
  baseRefName: string;
  isDraft: boolean;
  isCrossRepository: boolean;
}

export interface PrNativeGithubRunner {
  viewRevision(cwd: string, prNumber: number): GithubPrRevisionState;
  merge(cwd: string, prNumber: number, expectedHeadSha: string): void;
  closeIssue(cwd: string, repository: string, issueNumber: number): void;
  /** Optional on test doubles; the production runner enables repository-wide discovery. */
  listOpenPullRequests?(cwd: string, baseBranch: string): GithubOpenPullRequest[];
  fetchPullRequestHead?(
    cwd: string,
    prNumber: number,
    expectedHeadSha: string,
    headRefName?: string,
    baseRefName?: string,
  ): void;
  pullRequestChangedFiles?(cwd: string, prNumber: number): string[];
}

export interface RevisionGateInput {
  pr: PR;
  revision: PrRevision;
  requiredPerspectives: string[];
  github: GithubPrRevisionState;
  requiredChecks?: string[];
}

export const MAX_REVIEW_THREAD_REASON_BODY_CHARS = 500;

function currentRevisionRuns(
  store: Store,
  revision: PrRevision,
): EvalRun[] {
  return store.db.evalRuns.filter(
    (run) => run.prId === revision.prId
      && run.revisionId === revision.id
      && run.headSha === revision.headSha,
  );
}

function selectedChecks(
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
 * Observe one immutable PR head. A changed head immediately makes every older
 * non-terminal approval stale, before any review of the new revision can count.
 */
export function observePrRevision(
  store: Store,
  observedPr: PR,
  headSha: string,
): PrRevision {
  const pr = store.getPR(observedPr.id) ?? observedPr;
  if (pr.status === 'merged' || pr.status === 'closed') {
    throw new Error(`cannot observe a new revision for terminal PR ${pr.id} (${pr.status})`);
  }
  const parsedSha = PrHeadSha.parse(headSha);
  const existing = store.revisionForHead(pr.id, parsedSha);
  if (existing) {
    store.replacePR(pr.status === 'approved' && existing.status === 'approved'
      ? approvePR(pr, bindApprovalRevisionToPR(pr, existing))
      : transitionPR(pr, {
        status: pr.status === 'approved' ? 'open' : pr.status,
        currentRevisionId: existing.id,
        headSha: existing.headSha,
        mergedHeadSha: null,
      }));
    return existing;
  }

  for (const revision of store.db.prRevisions) {
    if (
      revision.prId === pr.id
      && revision.status !== 'merged'
      && revision.status !== 'failed'
      && revision.status !== 'stale'
    ) {
      store.replacePrRevision(stalePrRevision(revision, nowISO()));
    }
  }
  const revision = store.upsertPrRevision(PrRevision.parse({
    id: store.nextId('PRREV'),
    prId: pr.id,
    headSha: parsedSha,
    ordinal: store.db.prRevisions.filter((row) => row.prId === pr.id).length + 1,
    status: 'pending',
    createdAt: nowISO(),
  }));
  store.replacePR(transitionPR(pr, {
    status: 'open',
    currentRevisionId: revision.id,
    headSha: revision.headSha,
    mergedHeadSha: null,
  }));
  return revision;
}

/**
 * Deterministically decide one current-head gate. Even an `approve` EvalRun
 * cannot mask a P0/P1-equivalent blocker/major finding on the same revision.
 */
export function evaluateRevisionGate(
  store: Store,
  input: RevisionGateInput,
): RevisionGateSnapshotType {
  const runs = currentRevisionRuns(store, input.revision);
  const perspectiveVerdicts: Record<string, EvalRun['verdict']> = {};
  const blockingReasons: string[] = [];
  const pendingReasons: string[] = [];

  if (input.revision.status === 'stale') {
    blockingReasons.push('revision was invalidated by a later head');
  }

  for (const perspective of new Set(input.requiredPerspectives)) {
    const perspectiveRuns = runs.filter((candidate) => candidate.perspective === perspective);
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

  const checks = selectedChecks(input.github.checks, input.requiredChecks);
  for (const check of checks) {
    if (check.status === 'failure') blockingReasons.push(`required check failed: ${check.name}`);
    if (check.status === 'pending') pendingReasons.push(`required check pending: ${check.name}`);
  }
  for (const threadId of input.github.unresolvedBlockingThreadIds) {
    const thread = input.github.blockingReviewThreads?.find((candidate) => candidate.id === threadId);
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
  if (input.github.isDraft) {
    pendingReasons.push('pull request is draft');
  }
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
  return RevisionGateSnapshot.parse({
    id: store.nextId('PRGATE'),
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
    createdAt: nowISO(),
  });
}

function persistRevisionGateSnapshot(
  store: Store,
  candidate: RevisionGateSnapshotType,
): RevisionGateSnapshotType {
  const latest = store.db.revisionGateSnapshots
    .filter((snapshot) => snapshot.revisionId === candidate.revisionId)
    .at(-1);
  const comparable = (snapshot: RevisionGateSnapshotType) => ({
    headSha: snapshot.headSha,
    requiredPerspectives: snapshot.requiredPerspectives,
    perspectiveVerdicts: snapshot.perspectiveVerdicts,
    checks: snapshot.checks,
    unresolvedBlockingThreadIds: snapshot.unresolvedBlockingThreadIds,
    blockingReviewThreads: snapshot.blockingReviewThreads,
    mergeability: snapshot.mergeability,
    decision: snapshot.decision,
    blockingReasons: snapshot.blockingReasons,
    pendingReasons: snapshot.pendingReasons,
    reasons: snapshot.reasons,
  });
  if (latest && JSON.stringify(comparable(latest)) === JSON.stringify(comparable(candidate))) {
    return latest;
  }
  return store.addRevisionGateSnapshot(candidate);
}

export interface AutoMergeResult {
  prId: string;
  revisionId: string | null;
  headSha: string | null;
  decision:
    | RevisionGateSnapshotType['decision']
    | 'merged'
    | 'closed'
    | 'unverified-merge'
    | 'error';
  merged: boolean;
  reasons: string[];
}

function finalizeMergedRevision(
  store: Store,
  pr: Extract<PR, { status: 'approved' }>,
  revision: Extract<PrRevision, { status: 'approved' }>,
  runner: PrNativeGithubRunner,
  cwd: string,
): AutoMergeResult {
  const mergeBinding = bindMergeRevisionToPR(pr, revision);
  const mergedRevision = store.replacePrRevision(transitionPrRevision(revision, {
    status: 'merged',
    completedAt: nowISO(),
  }));
  const mergedPr = store.replacePR(mergeApprovedPR(
    pr,
    mergeBinding,
  ));
  if (store.getIssue(mergedPr.issueId)?.status !== 'released') {
    store.setStatus(mergedPr.issueId, 'released');
  }
  store.save();
  reconcileSplitSourceClosures(store, runner, cwd);
  return {
    prId: mergedPr.id,
    revisionId: mergedRevision.id,
    headSha: mergedRevision.headSha,
    decision: 'merged',
    merged: true,
    reasons: [],
  };
}

/** Reconcile previously reviewed PRs whose checks/threads may have changed since the last turn. */
export function reconcilePrNativeGates(
  store: Store,
  config: HarnessConfig,
  runner: PrNativeGithubRunner,
  cwd: string,
  requiredPerspectives: string[],
): AutoMergeResult[] {
  if ((config.gate?.backend ?? 'store') !== 'github') return [];
  const candidates = store.db.prs
    .filter((pr) =>
      pr.externalRef !== null && pr.status !== 'merged' && pr.status !== 'closed')
    .filter((pr) => {
      const issue = store.getIssue(pr.issueId);
      return issue !== undefined && issue.status !== 'released' && issue.status !== 'closed';
    });
  const results = candidates.map((pr): AutoMergeResult => {
    try {
      return autoMergeCurrentRevision(store, config, pr, runner, cwd, requiredPerspectives);
    } catch (error) {
      return {
        prId: pr.id,
        revisionId: pr.currentRevisionId,
        headSha: pr.headSha,
        decision: 'error',
        merged: false,
        reasons: [error instanceof Error ? error.message : String(error)],
      };
    }
  });
  reconcileSplitSourceClosures(store, runner, cwd);
  return results;
}

/**
 * A split Source Issue is closed only after every projected child work unit is
 * released. Failures stay durable and are retried by the next reconciliation.
 */
export function reconcileSplitSourceClosures(
  store: Store,
  runner: PrNativeGithubRunner,
  cwd: string,
): void {
  for (const intake of store.db.intakeRecords) {
    if (intake.storeIssueIds.length < 2 || intake.sourceClosedAt) continue;
    const allReleased = intake.storeIssueIds.every(
      (issueId) => store.getIssue(issueId)?.status === 'released',
    );
    if (!allReleased) continue;
    try {
      runner.closeIssue(cwd, intake.snapshot.repository, intake.snapshot.number);
      intake.sourceClosedAt = nowISO();
      intake.sourceCloseError = null;
    } catch (error) {
      intake.sourceCloseError = error instanceof Error ? error.message : String(error);
    }
    intake.updatedAt = nowISO();
    store.save();
  }
}

/**
 * Re-fetch current GitHub state, evaluate evidence tied to that exact SHA, then
 * merge with `--match-head-commit`. A push between evaluation and merge makes
 * the merge command fail rather than consuming stale approval.
 */
export function autoMergeCurrentRevision(
  store: Store,
  config: HarnessConfig,
  pr: PR,
  runner: PrNativeGithubRunner,
  cwd: string,
  requiredPerspectives: string[],
): AutoMergeResult {
  const externalRef = pr.externalRef;
  if (!externalRef) throw new Error(`${pr.id} is not projected to GitHub`);
  if (pr.status === 'merged' || pr.status === 'closed') {
    throw new Error(`${pr.id} is terminal (${pr.status})`);
  }
  const github = runner.viewRevision(cwd, externalRef.number);
  let revision = observePrRevision(store, pr, github.headSha);
  // Observation atomically projects the exact revision coordinates onto the PR.
  // Continue from that stored value rather than the caller's potentially unbound snapshot.
  pr = store.getPR(pr.id)!;
  if (revision.status === 'pending') {
    revision = store.replacePrRevision(transitionPrRevision(revision, {
      status: 'reviewing',
    }));
  }

  if (github.state === 'merged') {
    const approvedBeforeMerge = store.db.revisionGateSnapshots.find(
      (snapshot) => snapshot.revisionId === revision.id
        && snapshot.headSha === revision.headSha
        && snapshot.decision === 'approved',
    );
    const validatedApproval = ApprovedRevisionGateSnapshot.safeParse(approvedBeforeMerge);
    const revisionCanComplete = revision.status !== 'merged'
      && revision.status !== 'stale'
      && revision.status !== 'failed';
    if (!validatedApproval.success || !revisionCanComplete) {
      if (revisionCanComplete) {
        revision = store.replacePrRevision(transitionPrRevision(revision, {
          status: 'failed', completedAt: nowISO(),
        }));
      }
      const issue = store.getIssue(pr.issueId);
      if (
        issue
        && issue.status !== 'needs-human-review'
        && issue.status !== 'released'
        && issue.status !== 'closed'
      ) {
        store.setStatus(issue.id, 'needs-human-review');
      }
      store.save();
      return {
        prId: pr.id,
        revisionId: revision.id,
        headSha: revision.headSha,
        decision: 'unverified-merge',
        merged: false,
        reasons: [
          !validatedApproval.success
            ? 'GitHub reports merged but no approved gate snapshot exists for this head'
            : `GitHub reports merged but local revision is terminal (${revision.status})`,
        ],
      };
    }
    // Reconciliation consumes the validated approved variant, not a decision string.
    const approvedHeadSha = validatedApproval.data.headSha;
    if (approvedHeadSha !== revision.headSha) throw new Error('approved head changed during reconciliation');
    const approvedRevision = revision.status === 'approved'
      ? revision
      : store.replacePrRevision(transitionPrRevision(revision, { status: 'approved' }));
    const approvedPr = pr.status === 'approved'
      ? pr
      : store.replacePR(approvePR(pr, bindApprovalRevisionToPR(pr, approvedRevision)));
    if (approvedPr.status !== 'approved' || approvedRevision.status !== 'approved') {
      throw new Error('approved lifecycle transition did not produce approved variants');
    }
    return finalizeMergedRevision(store, approvedPr, approvedRevision, runner, cwd);
  }
  if (github.state === 'closed') {
    revision = store.replacePrRevision(transitionPrRevision(revision, {
      status: 'failed', completedAt: nowISO(),
    }));
    pr = store.replacePR(transitionPR(pr, { status: 'closed' }));
    store.save();
    return {
      prId: pr.id,
      revisionId: revision.id,
      headSha: revision.headSha,
      decision: 'closed',
      merged: false,
      reasons: ['pull request is closed without merge'],
    };
  }

  const snapshot = persistRevisionGateSnapshot(store, evaluateRevisionGate(store, {
    pr,
    revision,
    requiredPerspectives,
    github,
    requiredChecks: config.gate?.requiredChecks,
  }));
  if (snapshot.decision !== 'approved') {
    // A failed/stale revision is immutable evidence about this exact head. Gate
    // polling may still refresh checks, draft state, and external review threads,
    // but it must not resurrect that terminal revision as "reviewing".
    if (
      revision.status !== 'failed'
      && revision.status !== 'stale'
      && revision.status !== 'merged'
    ) {
      revision = store.replacePrRevision(snapshot.decision === 'pending'
        ? transitionPrRevision(revision, { status: 'reviewing' })
        : transitionPrRevision(revision, {
          status: 'changes-requested',
        }));
    }
    pr = store.replacePR(snapshot.decision === 'changes-requested'
      ? transitionPR(pr, { status: 'changes-requested' })
      : transitionPR(pr, { status: 'open' }));
    const issue = store.getIssue(pr.issueId);
    if (snapshot.decision === 'changes-requested' && issue) {
      if (issue.status === 'build-approved') {
        store.setStatus(issue.id, 'needs-human-review');
      }
      // Exhausting the bounded repair loop is a durable escalation. Polling the
      // same rejected revision must not turn needs-human-review back into a fresh
      // repair budget; only observing a new head re-enters evaluation.
      if (issue.status === 'evaluation-in-progress') {
        store.setStatus(issue.id, 'changes-requested');
      }
    }
    store.save();
    return {
      prId: pr.id,
      revisionId: revision.id,
      headSha: revision.headSha,
      decision: snapshot.decision,
      merged: false,
      reasons: [...snapshot.reasons],
    };
  }

  revision = store.replacePrRevision(transitionPrRevision(revision, { status: 'approved' }));
  pr = store.replacePR(approvePR(pr, bindApprovalRevisionToPR(pr, revision)));
  if (revision.mergeRequestedAt) {
    store.save();
    return {
      prId: pr.id,
      revisionId: revision.id,
      headSha: revision.headSha,
      decision: 'pending',
      merged: false,
      reasons: [`merge was requested at ${revision.mergeRequestedAt}; awaiting GitHub merged state`],
    };
  }
  // Persist the exact approved snapshot before the external merge. If the
  // process crashes after GitHub accepts the merge, reconciliation can prove
  // that this head had already passed rather than guessing from `state=merged`.
  store.save();
  runner.merge(cwd, externalRef.number, revision.headSha);
  revision = store.replacePrRevision(transitionPrRevision(revision, {
    status: 'approved', mergeRequestedAt: nowISO(),
  }));
  store.save();
  const afterMerge = runner.viewRevision(cwd, externalRef.number);
  if (afterMerge.headSha !== revision.headSha) {
    observePrRevision(store, pr, afterMerge.headSha);
    store.save();
    return {
      prId: pr.id,
      revisionId: revision.id,
      headSha: revision.headSha,
      decision: 'changes-requested',
      merged: false,
      reasons: [`head changed after merge request to ${afterMerge.headSha}`],
    };
  }
  if (afterMerge.state !== 'merged') {
    pr = store.replacePR(approvePR(pr, bindApprovalRevisionToPR(pr, revision)));
    store.save();
    return {
      prId: pr.id,
      revisionId: revision.id,
      headSha: revision.headSha,
      decision: 'pending',
      merged: false,
      reasons: ['merge request accepted or queued; awaiting GitHub merged state'],
    };
  }
  if (pr.status !== 'approved' || revision.status !== 'approved') {
    throw new Error('merge finalization requires approved PR and revision variants');
  }
  return finalizeMergedRevision(store, pr, revision, runner, cwd);
}
