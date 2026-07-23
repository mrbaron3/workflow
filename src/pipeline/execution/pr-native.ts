import { spawnSync } from 'node:child_process';
import type { HarnessConfig } from '../../config.js';
import {
  PrRevision,
  RevisionGateSnapshot,
  type EvalRun,
  type PR,
  type RevisionCheck,
  type RevisionReviewThread,
  type RevisionGateSnapshot as RevisionGateSnapshotType,
} from '../../domain/schema.js';
import { Store, nowISO } from '../../store/store.js';

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
  resolveReviewThread(cwd: string, threadId: string): void;
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

function internalRevisionApproved(
  store: Store,
  revision: PrRevision,
  requiredPerspectives: string[],
): boolean {
  const runs = currentRevisionRuns(store, revision);
  return [...new Set(requiredPerspectives)].every((perspective) => {
    const matches = runs.filter((run) => run.perspective === perspective);
    return matches.length > 0
      && matches.every((run) =>
        run.verdict === 'approve'
        && run.findings.every((finding) =>
          finding.severity !== 'blocker' && finding.severity !== 'major'));
  });
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
  pr: PR,
  headSha: string,
): PrRevision {
  const parsedSha = PrRevision.shape.headSha.parse(headSha);
  const existing = store.revisionForHead(pr.id, parsedSha);
  if (existing) {
    pr.currentRevisionId = existing.id;
    pr.headSha = existing.headSha;
    pr.updatedAt = nowISO();
    return existing;
  }

  for (const revision of store.db.prRevisions) {
    if (
      revision.prId === pr.id
      && revision.status !== 'merged'
      && revision.status !== 'failed'
      && revision.status !== 'stale'
    ) {
      revision.status = 'stale';
      revision.completedAt = nowISO();
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
  pr.currentRevisionId = revision.id;
  pr.headSha = revision.headSha;
  pr.status = 'open';
  pr.updatedAt = nowISO();
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
      + (thread ? ` — ${thread.body.slice(0, 500)}` : ''),
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
    reasons: snapshot.reasons,
  });
  if (latest && JSON.stringify(comparable(latest)) === JSON.stringify(comparable(candidate))) {
    return latest;
  }
  return store.addRevisionGateSnapshot(candidate);
}

export interface AutoMergeResult {
  prId: string;
  revisionId: string;
  headSha: string;
  decision:
    | RevisionGateSnapshotType['decision']
    | 'merged'
    | 'closed'
    | 'unverified-merge'
    | 'error';
  merged: boolean;
  reasons: string[];
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
    .filter((pr) => pr.externalRef !== null && pr.status !== 'merged')
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
        revisionId: pr.currentRevisionId ?? 'unobserved',
        headSha: pr.headSha ?? 'unknown',
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
  if (!pr.externalRef) throw new Error(`${pr.id} is not projected to GitHub`);
  let github = runner.viewRevision(cwd, pr.externalRef.number);
  let revision = observePrRevision(store, pr, github.headSha);

  // A repair revision whose fresh internal panel is clean may resolve the
  // external P0/P1 threads that triggered the prior revision's Repair Brief.
  // Never resolve a thread on first sight: it must exist in an older snapshot.
  if (github.state === 'open' && internalRevisionApproved(store, revision, requiredPerspectives)) {
    const repairedThreadIds = store.db.revisionGateSnapshots
      .filter((snapshot) =>
        snapshot.prId === pr.id
        && snapshot.revisionId !== revision.id
        && snapshot.decision === 'changes-requested')
      .flatMap((snapshot) => snapshot.blockingReviewThreads.map((thread) => thread.id))
      .filter((threadId) => !threadId.includes(':'));
    for (const threadId of new Set(repairedThreadIds)) {
      runner.resolveReviewThread(cwd, threadId);
    }
    if (repairedThreadIds.length > 0) {
      github = runner.viewRevision(cwd, pr.externalRef.number);
      revision = observePrRevision(store, pr, github.headSha);
    }
  }

  if (github.state === 'merged') {
    pr.status = 'merged';
    pr.mergedHeadSha = github.headSha;
    pr.updatedAt = nowISO();
    const approvedBeforeMerge = store.db.revisionGateSnapshots.some(
      (snapshot) => snapshot.revisionId === revision.id
        && snapshot.headSha === revision.headSha
        && snapshot.decision === 'approved',
    );
    if (!approvedBeforeMerge) {
      revision.status = 'failed';
      revision.completedAt = nowISO();
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
        reasons: ['GitHub reports merged but no approved gate snapshot exists for this head'],
      };
    }
    revision.status = 'merged';
    revision.completedAt = nowISO();
    if (store.getIssue(pr.issueId)?.status !== 'released') {
      store.setStatus(pr.issueId, 'released');
    }
    store.save();
    reconcileSplitSourceClosures(store, runner, cwd);
    return {
      prId: pr.id,
      revisionId: revision.id,
      headSha: revision.headSha,
      decision: 'merged',
      merged: true,
      reasons: [],
    };
  }
  if (github.state === 'closed') {
    revision.status = 'failed';
    revision.completedAt = nowISO();
    pr.status = 'changes-requested';
    pr.updatedAt = nowISO();
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
    revision.status = snapshot.decision === 'pending' ? 'reviewing' : 'changes-requested';
    revision.completedAt = snapshot.decision === 'changes-requested' ? nowISO() : null;
    pr.status = snapshot.decision === 'changes-requested' ? 'changes-requested' : 'open';
    pr.updatedAt = nowISO();
    const issue = store.getIssue(pr.issueId);
    if (snapshot.decision === 'changes-requested' && issue) {
      if (issue.status === 'build-approved') {
        store.setStatus(issue.id, 'needs-human-review');
      }
      if (
        issue.status === 'needs-human-review'
        || issue.status === 'evaluation-in-progress'
      ) {
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
      reasons: snapshot.reasons,
    };
  }

  revision.status = 'approved';
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
  runner.merge(cwd, pr.externalRef.number, revision.headSha);
  revision.mergeRequestedAt = nowISO();
  store.save();
  const afterMerge = runner.viewRevision(cwd, pr.externalRef.number);
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
    pr.status = 'approved';
    pr.updatedAt = nowISO();
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
  revision.status = 'merged';
  revision.completedAt = nowISO();
  pr.status = 'merged';
  pr.mergedHeadSha = revision.headSha;
  pr.updatedAt = nowISO();
  if (store.getIssue(pr.issueId)?.status !== 'released') store.setStatus(pr.issueId, 'released');
  store.save();
  reconcileSplitSourceClosures(store, runner, cwd);
  return {
    prId: pr.id,
    revisionId: revision.id,
    headSha: revision.headSha,
    decision: 'merged',
    merged: true,
    reasons: [],
  };
}

function run(cmd: string, args: string[], cwd: string): string {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result.stdout ?? '';
}

function checkStatus(raw: Record<string, unknown>): RevisionCheck['status'] {
  const value = String(raw.conclusion ?? raw.state ?? raw.status ?? '').toUpperCase();
  if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(value)) return 'success';
  if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(value)) {
    return 'failure';
  }
  return 'pending';
}

function blockingReviewThreads(cwd: string, nodeId: string): RevisionReviewThread[] {
  const query = `query($id: ID!) {
    node(id: $id) {
      ... on PullRequest {
        reviewThreads(first: 100) {
          pageInfo { hasNextPage }
          nodes {
            id
            isResolved
            path
            line
            comments(first: 100) { pageInfo { hasNextPage } nodes { body } }
          }
        }
      }
    }
  }`;
  const output = run('gh', ['api', 'graphql', '-f', `query=${query}`, '-F', `id=${nodeId}`], cwd);
  const parsed = JSON.parse(output) as {
    data?: { node?: { reviewThreads?: {
      pageInfo?: { hasNextPage?: boolean };
      nodes?: Array<{
      id?: string;
      isResolved?: boolean;
      path?: string | null;
      line?: number | null;
      comments?: {
        pageInfo?: { hasNextPage?: boolean };
        nodes?: Array<{ body?: string }>;
      };
    }> } } };
  };
  const threads = parsed.data?.node?.reviewThreads;
  const blocking = (threads?.nodes ?? [])
    .filter((thread) => !thread.isResolved)
    .filter((thread) => (thread.comments?.nodes ?? []).some(
      (comment) => /\[(?:P0|P1)\]|\bblocker\b|\brequest_changes\b/i.test(comment.body ?? ''),
    ) || thread.comments?.pageInfo?.hasNextPage)
    .flatMap((thread): RevisionReviewThread[] => {
      if (typeof thread.id !== 'string' || thread.id.length === 0) return [];
      const bodies = (thread.comments?.nodes ?? [])
        .map((comment) => comment.body ?? '')
        .filter((body) => /\[(?:P0|P1)\]|\bblocker\b|\brequest_changes\b/i.test(body));
      const body = bodies.join('\n\n').trim()
        || 'Blocking thread comments exceeded the inspected page; inspect the thread before merge.';
      return [{
        id: thread.id,
        body: body.slice(0, 8_000),
        path: thread.path ?? null,
        line: thread.line ?? null,
      }];
    });
  if (threads?.pageInfo?.hasNextPage) {
    blocking.push({
      id: 'review-threads:pagination-incomplete',
      body: 'More than 100 review threads exist; inspect the remaining page before merge.',
      path: null,
      line: null,
    });
  }
  return blocking;
}

/** Production GitHub adapter. No `--admin`: branch protections remain authoritative. */
export function realPrNativeGithubRunner(
  mergeMethod: NonNullable<HarnessConfig['gate']>['mergeMethod'] = 'squash',
): PrNativeGithubRunner {
  return {
    viewRevision(cwd, prNumber) {
      const output = run('gh', [
        'pr',
        'view',
        String(prNumber),
        '--json',
        'id,state,isDraft,headRefOid,mergeable,reviewDecision,statusCheckRollup',
      ], cwd);
      const raw = JSON.parse(output) as {
        id: string;
        state: string;
        isDraft?: boolean;
        headRefOid: string;
        mergeable: string;
        reviewDecision?: string;
        statusCheckRollup?: Array<Record<string, unknown>>;
      };
      const checks = (raw.statusCheckRollup ?? []).map((check, index) => ({
        name: String(check.name ?? check.context ?? `check-${index + 1}`),
        status: checkStatus(check),
      }));
      const blockingThreads = blockingReviewThreads(cwd, raw.id);
      if (String(raw.reviewDecision).toUpperCase() === 'CHANGES_REQUESTED') {
        blockingThreads.push({
          id: 'review-decision:changes-requested',
          body: 'GitHub reviewDecision is CHANGES_REQUESTED.',
          path: null,
          line: null,
        });
      }
      const state = String(raw.state).toUpperCase();
      return {
        state: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open',
        headSha: raw.headRefOid,
        isDraft: raw.isDraft ?? false,
        mergeability: String(raw.mergeable).toUpperCase() === 'MERGEABLE'
          ? 'mergeable'
          : String(raw.mergeable).toUpperCase() === 'CONFLICTING'
            ? 'conflicting'
            : 'unknown',
        checks,
        unresolvedBlockingThreadIds: [...new Set(blockingThreads.map((thread) => thread.id))],
        blockingReviewThreads: blockingThreads,
      };
    },
    listOpenPullRequests(cwd, baseBranch) {
      const output = run('gh', [
        'pr',
        'list',
        '--state',
        'open',
        '--base',
        baseBranch,
        '--limit',
        '100',
        '--json',
        'number,url,title,body,headRefName,headRefOid,baseRefName,isDraft,isCrossRepository',
      ], cwd);
      const rows = JSON.parse(output) as Array<{
        number: number;
        url: string;
        title: string;
        body?: string;
        headRefName: string;
        headRefOid: string;
        baseRefName: string;
        isDraft?: boolean;
        isCrossRepository?: boolean;
      }>;
      return rows.map((row) => ({
        number: row.number,
        url: row.url,
        title: row.title,
        body: row.body ?? '',
        headRefName: row.headRefName,
        headSha: row.headRefOid,
        baseRefName: row.baseRefName,
        isDraft: row.isDraft ?? false,
        isCrossRepository: row.isCrossRepository ?? false,
      }));
    },
    fetchPullRequestHead(cwd, prNumber, expectedHeadSha, headRefName, baseRefName) {
      const localRef = `refs/agentops/pull/${prNumber}`;
      const refspecs = [
        `+refs/pull/${prNumber}/head:${localRef}`,
        ...(headRefName
          ? [`+refs/heads/${headRefName}:refs/remotes/origin/${headRefName}`]
          : []),
        ...(baseRefName && baseRefName !== headRefName
          ? [`+refs/heads/${baseRefName}:refs/remotes/origin/${baseRefName}`]
          : []),
      ];
      run('git', [
        'fetch',
        '--no-tags',
        'origin',
        ...refspecs,
      ], cwd);
      const fetched = run('git', ['rev-parse', localRef], cwd).trim();
      if (fetched !== expectedHeadSha) {
        throw new Error(
          `PR #${prNumber} head changed while fetching: expected ${expectedHeadSha}, got ${fetched}`,
        );
      }
    },
    pullRequestChangedFiles(cwd, prNumber) {
      return run('gh', ['pr', 'diff', String(prNumber), '--name-only'], cwd)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    },
    merge(cwd, prNumber, expectedHeadSha) {
      run('gh', [
        'pr',
        'merge',
        String(prNumber),
        `--${mergeMethod}`,
        '--match-head-commit',
        expectedHeadSha,
        '--delete-branch',
      ], cwd);
    },
    resolveReviewThread(cwd, threadId) {
      const mutation = `mutation($threadId: ID!) {
        resolveReviewThread(input: {threadId: $threadId}) {
          thread { id isResolved }
        }
      }`;
      run('gh', [
        'api',
        'graphql',
        '-f',
        `query=${mutation}`,
        '-F',
        `threadId=${threadId}`,
      ], cwd);
    },
    closeIssue(cwd, repository, issueNumber) {
      run('gh', [
        'issue',
        'close',
        String(issueNumber),
        '--repo',
        repository,
        '--comment',
        'すべての分割work unitが自動レビュー・merge済みのためcloseします。',
      ], cwd);
    },
  };
}
