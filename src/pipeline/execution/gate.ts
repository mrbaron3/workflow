/**
 * GitHub PR projection seams. projectReviewRevision is the production PR-native
 * path: it binds every review cycle to a pushed head SHA. openGate/pollGate are
 * retained for the legacy human-gate workflow and its compatibility tests.
 *
 * Same shape as the other execution seams — a non-deterministic producer feeding a deterministic
 * sink (ARCH-execution-011). The store is SoT (ADR-0001 / ARCH-execution-009); a GitHub PR is only
 * the UI of the human decision point, so the split is:
 *   1. openGate (side-effecting): push the branch + `gh pr create`, record PR.externalRef — project
 *      an approved build to the gate UI. A no-op for the `store` backend (gate stays direct).
 *   2. pollGate (mostly pure): read each needs-human-review PR's state and, via the pure
 *      prStateToDecision map, feed merged→approve / closed→reject into recordHumanDecision.
 * All git/`gh` I/O is behind the GhGateRunner interface so the routing + store transitions are
 * unit-testable with a fake runner (no network); only the real runner shells out (grounded only).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PR, EvalRun } from '../../domain/schema.js';
import {
  PrExternalRef,
  requireMutablePR,
  transitionPR,
  updatePR,
} from '../../domain/schema.js';
import type { HarnessConfig } from '../../config.js';
import { Store } from '../../store/store.js';
import { recordHumanDecision, type HumanDecision } from './loop.js';
import {
  runCommand as run,
  type RunCommandOptions,
} from './command.js';
import { observePrRevision } from './pr-native.js';
import {
  canonicalGithubRepository,
  parsePullRequestClosingTarget,
  parseWorkIdentityMarker,
  projectedWorkIdentity,
  renderWorkIdentityMarker,
  sameProjectedWorkIdentity,
  samePullRequestClosingTarget,
  type ExternalWorkIdentity,
  type ProjectedWorkIdentity,
} from './work-identity.js';

/** A GitHub PR's lifecycle state, normalised from `gh pr view --json state`. */
export type GhPrState = 'open' | 'merged' | 'closed';

export type GateCommandRunner = (
  cmd: string,
  args: string[],
  cwd: string,
  options?: RunCommandOptions,
) => string;

export interface CreatePullRequestArgs {
  base: string;
  head: string;
  title: string;
  body: string;
}

/**
 * The pure heart of the gate: a polled PR state → the human decision it stands for (ADR-0006 G1).
 * `open` = the human hasn't acted yet, so no decision (keep polling). merged = the human accepted
 * the panel-approved build → release. closed (unmerged) = the human rejected it → repair lane.
 */
export function prStateToDecision(state: GhPrState): HumanDecision | null {
  switch (state) {
    case 'merged':
      return 'approve';
    case 'closed':
      return 'reject';
    case 'open':
      return null;
  }
}

/** The git/`gh` side effects the gate needs, behind an interface so tests inject a fake. */
export interface GhGateRunner {
  /**
   * Read-only identity check before the first push. An existing branch without
   * an exact repository/Issue/release/body-correlated PR is ambiguous.
   */
  preflightPr(
    cwd: string,
    args: CreatePullRequestArgs & { existingRef: PrExternalRef | null },
  ): PrExternalRef | null;
  /** Push `branch` (checked out in `worktree`) to the remote so a PR can target it. */
  pushBranch(worktree: string, branch: string): void;
  /** Ensure an open PR from `head` into `base`; return its number + url. */
  createPr(cwd: string, args: CreatePullRequestArgs): PrExternalRef;
  /** The current lifecycle state of PR `number`. `cwd` is any checkout of the target repo. */
  viewPr(cwd: string, prNumber: number): GhPrState;
}

/** Stable PR identity: any local repair branch publishes its HEAD to the original GitHub head. */
export function prHeadRefspec(branch: string): string {
  return `HEAD:refs/heads/${branch}`;
}

/**
 * Publish a generated HEAD with a lease grounded in the mirror's last fetch.
 *
 * Production passes a literal GitHub URL instead of the configured `origin`
 * name. Bare `--force-with-lease` cannot associate that URL with
 * `refs/remotes/origin/*`, so it treats an existing destination as stale even
 * when the fetched tracking ref matches it. Spell out the expected object:
 * an existing tracking ref must still be at that SHA, while an absent tracking
 * ref requires the destination branch to remain absent.
 */
export function pushGeneratedBranch(
  worktree: string,
  remote: string,
  branch: string,
): void {
  const destination = `refs/heads/${branch}`;
  const trackingRef = `refs/remotes/origin/${branch}`;
  const published = run('git', [
    '-C',
    worktree,
    'rev-parse',
    '--verify',
    'HEAD^{commit}',
  ], worktree).trim();
  let expected = '';
  try {
    expected = run('git', [
      '-C',
      worktree,
      'rev-parse',
      '--verify',
      `${trackingRef}^{commit}`,
    ], worktree).trim();
  } catch {
    // An empty expected object is Git's explicit "branch must not exist"
    // lease. If probing failed for any other reason, the push still fails
    // closed whenever the destination already exists.
  }
  run('git', [
    '-C',
    worktree,
    'push',
    `--force-with-lease=${destination}:${expected}`,
    '-u',
    remote,
    prHeadRefspec(branch),
  ], worktree, { credentials: 'github' });

  // A named-remote push advances its remote-tracking ref, but a literal URL
  // does not. Production uses a literal GitHub URL, so carry the successfully
  // published object forward as the next repair attempt's lease. The old-value
  // fence prevents this bookkeeping step from overwriting a concurrent fetch.
  const trackedAfterPush = (() => {
    try {
      return run('git', [
        '-C',
        worktree,
        'rev-parse',
        '--verify',
        `${trackingRef}^{commit}`,
      ], worktree).trim();
    } catch {
      return '';
    }
  })();
  if (trackedAfterPush !== published) {
    run('git', [
      '-C',
      worktree,
      'update-ref',
      trackingRef,
      published,
      expected || '0'.repeat(40),
    ], worktree);
  }
}

export interface OpenGateInput {
  pr: PR;
  /** The checkout whose branch is pushed and from which the PR is opened. */
  worktree: string;
  title: string;
}

export interface ProjectReviewRevisionInput extends OpenGateInput {
  headSha: string;
  /** Committed cumulative diff paths, derived from git rather than provider prose. */
  changedFiles?: readonly string[];
  /** External mutation identity. null/absent only for local sandbox work. */
  workIdentity?: ExternalWorkIdentity | null;
  sampleIndex?: number;
}

/** GitHub rejects a longer pull request body; stay under it with headroom. */
export const MAX_REVIEW_PR_BODY_CHARS = 60_000;
/** GitHub rejects a longer pull request title. */
export const MAX_REVIEW_PR_TITLE_CHARS = 256;

export interface ReviewPrRenderContext {
  baseBranch: string;
  headBranch: string;
  headSha: string;
  changedFiles?: readonly string[];
}

/**
 * PR-first projection: push the new build revision before any LLM perspective
 * reviews it. Repair attempts reuse the same external PR and only advance its head.
 */
export function projectReviewRevision(
  store: Store,
  config: HarnessConfig,
  input: ProjectReviewRevisionInput,
  runner: GhGateRunner,
  log: (m: string) => void = () => {},
  beforeCreatePr?: () => Promise<void>,
  beforePush?: () => Promise<void>,
) {
  return projectReviewRevisionAsync(
    store,
    config,
    input,
    runner,
    log,
    beforeCreatePr,
    beforePush,
  );
}

async function projectReviewRevisionAsync(
  store: Store,
  config: HarnessConfig,
  input: ProjectReviewRevisionInput,
  runner: GhGateRunner,
  log: (m: string) => void,
  beforeCreatePr?: () => Promise<void>,
  beforePush?: () => Promise<void>,
) {
  let projectedPr = store.getPR(input.pr.id) ?? input.pr;
  if ((config.gate?.backend ?? 'store') !== 'github') {
    return observePrRevision(store, projectedPr, input.headSha);
  }

  const base = config.gate?.baseBranch ?? config.baseBranch;
  const projectedIdentity = input.workIdentity
    ? projectedWorkIdentity(input.workIdentity, input.sampleIndex ?? 0)
    : null;
  const body = renderReviewPrBody(
    store,
    input.pr.issueId,
    projectedIdentity,
    {
      baseBranch: base,
      headBranch: input.pr.branch,
      headSha: input.headSha,
      changedFiles: input.changedFiles,
    },
  );
  const preflight = runner.preflightPr(input.worktree, {
    base,
    head: input.pr.branch,
    title: input.title,
    body,
    existingRef: projectedPr.externalRef,
  });
  if (projectedPr.externalRef && !preflight) {
    throw new Error(
      `existing PR #${projectedPr.externalRef.number} did not pass projection identity preflight`,
    );
  }

  const revision = observePrRevision(store, projectedPr, input.headSha);
  await beforePush?.();
  runner.pushBranch(input.worktree, input.pr.branch);
  projectedPr = store.getPR(input.pr.id) ?? projectedPr;
  if (!projectedPr.externalRef) {
    let resolvedRef = preflight;
    if (!resolvedRef) {
      await beforeCreatePr?.();
      resolvedRef = PrExternalRef.parse(runner.createPr(input.worktree, {
        base,
        head: input.pr.branch,
        title: input.title,
        body,
      }));
    }
    const parsedRef = PrExternalRef.parse(resolvedRef);
    projectedPr = store.replacePR(updatePR(requireMutablePR(projectedPr), { externalRef: parsedRef }));
    log(
      `  ⇪ ${input.pr.issueId}: ${preflight ? 'reused' : 'opened'} review PR `
      + `${parsedRef.url} @ ${input.headSha.slice(0, 12)}`,
    );
  } else if (preflight) {
    projectedPr = store.replacePR(updatePR(requireMutablePR(projectedPr), {
      externalRef: PrExternalRef.parse(preflight),
    }));
    log(
      `  ⇪ ${input.pr.issueId}: pushed repair revision `
      + `${input.headSha.slice(0, 12)} to PR #${preflight.number}`,
    );
  }
  store.replacePR(updatePR(requireMutablePR(projectedPr), {
    agentGeneratedHeadSha: revision.headSha,
  }));
  store.save();
  return revision;
}

/**
 * Project an approved build to the gate UI (ADR-0006 G1). For the `store` backend this is a no-op
 * — the build already sits at needs-human-review awaiting a direct recordHumanDecision. For
 * `github` it pushes the branch, opens a PR whose body is the human-readable panel render, and
 * records PR.externalRef. Idempotent: a PR that already has an externalRef is not re-created.
 */
export function openGate(
  store: Store,
  config: HarnessConfig,
  input: OpenGateInput,
  runner: GhGateRunner,
  log: (m: string) => void = () => {},
): PrExternalRef | null {
  if ((config.gate?.backend ?? 'store') !== 'github') return null; // store-direct gate: nothing to project
  const currentPr = store.getPR(input.pr.id) ?? input.pr;
  if (currentPr.externalRef) return currentPr.externalRef; // already projected (idempotent)

  const base = config.gate?.baseBranch ?? config.baseBranch;
  const body = renderGatePrBody(store, input.pr.issueId);
  const preflight = runner.preflightPr(input.worktree, {
    base,
    head: input.pr.branch,
    title: input.title,
    body,
    existingRef: null,
  });
  runner.pushBranch(input.worktree, input.pr.branch);
  const ref = PrExternalRef.parse(preflight ?? runner.createPr(
    input.worktree,
    { base, head: input.pr.branch, title: input.title, body },
  ));
  store.replacePR(updatePR(requireMutablePR(currentPr), { externalRef: ref }));
  store.save();
  log(`  ⇪ ${input.pr.issueId}: opened gate PR ${ref.url}`);
  return ref;
}

export interface GatePollResult {
  issueId: string;
  prId: string;
  state: GhPrState;
  decision: HumanDecision | null;
  status: string;
  changed: boolean;
}

/**
 * Poll every needs-human-review issue whose PR was projected to GitHub and convert a terminal PR
 * state into recordHumanDecision (ADR-0006 G1/G3). merged → released + humanVerdict=approve
 * (true-pass); closed → repair lane + humanVerdict=request_changes (a false-pass the panel let
 * through). An still-open PR is left pending. A no-op for the `store` backend. Deterministic given
 * the runner's answers, and idempotent: a released issue is no longer needs-human-review, so it is
 * never re-processed.
 */
export function pollGate(
  store: Store,
  config: HarnessConfig,
  runner: GhGateRunner,
  cwd: string,
  log: (m: string) => void = () => {},
): GatePollResult[] {
  if ((config.gate?.backend ?? 'store') !== 'github') return []; // store-direct gate: nothing to poll

  const results: GatePollResult[] = [];
  for (const issue of store.db.issues) {
    if (issue.status !== 'needs-human-review') continue;
    const pr = store.db.prs.find((p) => p.issueId === issue.id && p.externalRef?.provider === 'github');
    if (!pr?.externalRef) continue;

    const state = runner.viewPr(cwd, pr.externalRef.number);
    const decision = prStateToDecision(state);
    if (decision === null) {
      results.push({ issueId: issue.id, prId: pr.id, state, decision, status: issue.status, changed: false });
      continue;
    }

    const rec = recordHumanDecision(store, issue.id, decision);
    if (decision === 'approve') {
      // Legacy state-only runners cannot prove a commit identity. Release the
      // legacy work unit but do not fabricate revision evidence or a merged PR
      // variant; the PR-native path records the real full SHA before merging.
    } else {
      store.replacePR(transitionPR(pr, { status: 'changes-requested' }));
    }
    log(`  ⇩ ${issue.id}: PR #${pr.externalRef.number} ${state} → ${decision} → ${rec.status}`);
    results.push({ issueId: issue.id, prId: pr.id, state, decision, status: rec.status, changed: rec.changed });
  }
  store.save();
  return results;
}

/**
 * The human-readable PR body (ADR-0006 G1): the evaluator panel's per-perspective verdict on the
 * build the human is judging, plus its findings. Rendered from the winning attempt's EvalRuns so a
 * reviewer sees WHY the harness approved before deciding to merge (release) or close (send back).
 * Prose is Japanese (issue/PR authoring rule, CLAUDE.md); identifiers and enum values stay verbatim.
 * When an intake produced one work unit, a `Closes owner/repo#N` reference ties its merge to the
 * Source Snapshot's issue. Split intake work uses `Refs` instead: no child PR may close the source
 * while sibling work remains. The qualified form also survives a gate repo that differs from the
 * intake repo.
 */
function storeProjectedWorkIdentity(
  store: Store,
  issueId: string,
  sampleIndex: number,
): ProjectedWorkIdentity | null {
  const source = store.db.intakeRecords.find((record) =>
    record.storeIssueIds.includes(issueId));
  if (!source) return null;
  const issue = store.getIssue(issueId);
  if (!issue) throw new Error(`No issue: ${issueId}`);
  const workUnitKey = source.storeIssueIds.length === 1
    ? 'source'
    : issue.planningCandidateKey;
  if (!workUnitKey) {
    throw new Error(
      `${issueId} is one of multiple external work units but has no stable planning candidate key`,
    );
  }
  return projectedWorkIdentity({
    repository: source.snapshot.repository,
    issueNumber: source.snapshot.number,
    intakeKey: source.intakeKey,
    workUnitKey,
    releaseId: null,
  }, sampleIndex);
}

export function renderGatePrBody(store: Store, issueId: string): string {
  const runs = latestAttemptRuns(store.runsForIssue(issueId));
  const lines = [
    `自動評価パネルはこのビルドを**承認**しました。**マージ＝リリース**、**クローズ＝修理レーンへ差し戻し**です。`,
    `この選択は人間の最終判定として記録されます（false-pass 較正、ADR-0006 G3）。`,
    ``,
    `## パネル評決`,
  ];
  for (const r of runs) {
    const lens = r.perspective ?? 'composite';
    lines.push(`- **${lens}**: ${r.verdict}`);
    for (const f of r.findings) lines.push(`  - [${f.severity}] ${f.criterionId}: ${f.observed || f.expected || '—'}`);
  }
  const source = store.db.intakeRecords.find((rec) => rec.storeIssueIds.includes(issueId));
  if (source) {
    const identity = storeProjectedWorkIdentity(
      store,
      issueId,
      runs[0]?.sampleIndex ?? 0,
    );
    if (!identity) throw new Error(`${issueId} has no external work identity`);
    const relation = source.storeIssueIds.length === 1 ? 'Closes' : 'Refs';
    lines.push(
      ``,
      renderWorkIdentityMarker(identity),
      ``,
      `${relation} ${source.snapshot.repository}#${source.snapshot.number}`,
    );
  }
  return lines.join('\n');
}

/** Initial body for a PR created before its first perspective review. */
export function renderReviewPrBody(
  store: Store,
  issueId: string,
  identity: ProjectedWorkIdentity | null = null,
  context: ReviewPrRenderContext | null = null,
): string {
  const issue = store.getIssue(issueId);
  if (!issue) throw new Error(`No issue: ${issueId}`);
  if (!issue.contract) throw new Error(`${issueId} has no accepted contract`);
  const contract = issue.contract;
  const source = store.db.intakeRecords.find((record) => record.storeIssueIds.includes(issueId));
  const effectiveIdentity = identity
    ?? storeProjectedWorkIdentity(store, issueId, 0);
  if (effectiveIdentity) {
    if (!source) {
      throw new Error(`${issueId} has external work identity but no Source Issue projection`);
    }
    const issue = store.getIssue(issueId);
    const expectedWorkUnitKey = source.storeIssueIds.length === 1
      ? 'source'
      : issue?.planningCandidateKey;
    if (
      canonicalGithubRepository(source.snapshot.repository) !== effectiveIdentity.repository
      || source.snapshot.number !== effectiveIdentity.issueNumber
      || source.intakeKey !== effectiveIdentity.intakeKey
      || expectedWorkUnitKey !== effectiveIdentity.workUnitKey
    ) {
      throw new Error(`${issueId} external work identity does not match its Source Issue`);
    }
  }

  const projectedPr = store.prForIssue(issueId);
  const revision = context ?? {
    baseBranch: projectedPr?.baseBranch ?? 'unprojected',
    headBranch: projectedPr?.branch ?? 'unprojected',
    headSha: projectedPr?.headSha ?? 'pending',
  };
  const includeScope = contract.scope.include.length > 0
    ? contract.scope.include.map(markdownText).join('<br>')
    : 'No include glob declared';
  const excludeScope = contract.scope.exclude.length > 0
    ? contract.scope.exclude.map(markdownText).join('<br>')
    : 'No exclude glob declared';
  const declaredAdrs = explicitAdrReferences([
    source?.snapshot.body ?? '',
    ...contract.redLines,
    ...issue.implementationNotes,
  ]);
  const architectureDependencies = issue.dependsOnSystem
    .filter((dependency) => /^(?:ARCH|DATA|DOM|LANG)-/.test(dependency));
  const changedFiles = [...new Set(context?.changedFiles ?? [])].sort();
  const composeHead = (fileLimit: number, criterionLimit: number): string[] => {
    const visibleChangedFiles = changedFiles.slice(0, fileLimit);
    const visibleCriteria = contract.acceptanceCriteria.slice(0, criterionLimit);
    const lines = [
      '## Summary',
      '',
      `- **Product goal:** ${markdownText(contract.productGoal)}`,
      `- **User story:** ${markdownText(contract.userStory)}`,
      `- **Work unit:** ${markdownText(issue.title)}`,
      '',
      `Changed files recorded from the committed build: **${changedFiles.length}**`,
      '',
      '| Path | Projection |',
      '| --- | --- |',
      ...(visibleChangedFiles.length > 0
        ? visibleChangedFiles.map((file) => `| ${markdownText(file)} | generated revision |`)
        : ['| — | no changed file was reported |']),
      ...(changedFiles.length > visibleChangedFiles.length
        ? [`| … | ${changedFiles.length - visibleChangedFiles.length} additional files; inspect the GitHub diff |`]
        : []),
      '',
      'This pull request is managed by the AgentOps current-head review and bounded repair loop.',
      'Only an exact reviewed head may be merged.',
      '',
      '## Architecture baseline',
      '',
      '| Boundary | Before | After |',
      '| --- | --- | --- |',
      `| Revision | Base branch \`${markdownCode(revision.baseBranch)}\` | Generated branch \`${markdownCode(revision.headBranch)}\` at \`${markdownCode(revision.headSha)}\` |`,
      `| Declared include scope | Existing repository state | ${includeScope} |`,
      `| Declared exclusions | Existing repository state | ${excludeScope} |`,
      '',
      'Repository-specific architecture counters are not inferred or fabricated.',
      'Any baseline explicitly required by the frozen Source Issue remains a validation obligation.',
      '',
      '## Applicable ADRs',
      '',
    ];
    if (declaredAdrs.length > 0) {
      lines.push(...declaredAdrs.map((reference) => `- ${markdownText(reference)}`));
    } else {
      lines.push('- No explicit ADR identifier was declared in the frozen Source Issue or accepted contract.');
    }
    if (architectureDependencies.length > 0) {
      lines.push(
        `- Accepted architecture dependencies: ${architectureDependencies.map(markdownText).join(', ')}`,
      );
    }
    if (contract.redLines.length > 0) {
      lines.push('', 'Contract guardrails:', ...contract.redLines.map((line) => `- ${markdownText(line)}`));
    }
    lines.push(
      '',
      '## Validation',
      '',
      '| Criterion | Severity | Method | Required outcome |',
      '| --- | --- | --- | --- |',
      ...visibleCriteria.map((criterion) => (
        `| ${markdownText(criterion.id)} | ${markdownText(criterion.severity)} | `
        + `${markdownText(criterion.verification.method)} | `
        + `${criterion.verification.expected.map(markdownText).join('<br>')} |`
      )),
      ...(contract.acceptanceCriteria.length > visibleCriteria.length
        ? [`| … | | | ${contract.acceptanceCriteria.length - visibleCriteria.length} additional criteria; read the accepted contract |`]
        : []),
      '',
      'Status at PR creation: **pending current-head validation**.',
      'AgentOps runs repository graders, required review perspectives, GitHub checks, and blocking-thread reconciliation before merge.',
      '',
      '## Rollback',
      '',
      '- Default code rollback: revert the merge commit for this pull request.',
      '- AgentOps does not infer or execute destructive data rollback; repository-specific migration recovery instructions remain authoritative.',
    );
    return lines;
  };

  // GitHub caps a pull request body at 65536 characters. The changed-file and
  // criterion tables are the only unbounded sections and they are a reading
  // convenience; the tracking coordinates, work-identity marker, and closing
  // keyword below are load-bearing and are never dropped. Shrink the tables —
  // and, as a last resort, the descriptive head — instead of failing a
  // projection whose PR is otherwise complete and correct.
  const lines: string[] = [
    '## Tracking',
    '',
  ];
  if (source) {
    lines.push(`- Source Issue: ${source.snapshot.repository}#${source.snapshot.number}`);
  } else {
    lines.push('- Source Issue: none (local work unit)');
  }
  lines.push(
    `- Work unit key: ${markdownText(effectiveIdentity?.workUnitKey ?? issue.planningCandidateKey ?? issue.id)}`,
    `- Base branch: \`${markdownCode(revision.baseBranch)}\``,
    `- Generated head: \`${markdownCode(revision.headSha)}\``,
  );
  if (effectiveIdentity?.releaseId) {
    lines.push(`- Release correlation: \`${markdownCode(effectiveIdentity.releaseId)}\``);
  }
  if (effectiveIdentity) {
    lines.push('', renderWorkIdentityMarker(effectiveIdentity));
  }
  if (source) {
    const relation = source.storeIssueIds.length === 1 ? 'Closes' : 'Refs';
    lines.push('', `${relation} ${source.snapshot.repository}#${source.snapshot.number}`);
  }
  const tail = lines.join('\n');
  const criteria = contract.acceptanceCriteria.length;
  for (const [fileLimit, criterionLimit] of [
    [100, criteria],
    [25, criteria],
    [25, 25],
    [0, 10],
    [0, 0],
  ]) {
    const body = `${composeHead(fileLimit!, criterionLimit!).join('\n')}\n\n${tail}`;
    if (body.length <= MAX_REVIEW_PR_BODY_CHARS) return body;
  }
  // Contract prose alone can exceed the budget. Cut the head at a line boundary
  // and say so, so the tail — identity, tracking, and closing keyword — always
  // survives intact.
  const notice = '\n\n_Body truncated to fit GitHub\'s pull request size limit._';
  const head = composeHead(0, 0).join('\n');
  const budget = MAX_REVIEW_PR_BODY_CHARS - tail.length - notice.length - 2;
  const cut = head.slice(0, Math.max(0, budget));
  const trimmed = cut.slice(0, Math.max(0, cut.lastIndexOf('\n')));
  return `${trimmed}${notice}\n\n${tail}`;
}

/** Stable user-facing title. Never expose job-local ISSUE-N identifiers to GitHub. */
export function renderReviewPrTitle(store: Store, issueId: string): string {
  const issue = store.getIssue(issueId);
  if (!issue) throw new Error(`No issue: ${issueId}`);
  const source = store.db.intakeRecords.find((record) => record.storeIssueIds.includes(issueId));
  const raw = source?.storeIssueIds.length === 1
    ? source.snapshot.title
    : issue.planningCandidateKey
      ? `[${issue.planningCandidateKey.replace(/\]/g, '-')}] ${issue.title}`
      : issue.title;
  const title = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  // An empty title is a projection defect and stays fatal. An over-long one is
  // ordinary Source Issue prose: truncate it rather than fail the PR.
  if (title.length === 0) {
    throw new Error(`${issueId} generated pull request title is empty`);
  }
  return title.length <= MAX_REVIEW_PR_TITLE_CHARS
    ? title
    : `${title.slice(0, MAX_REVIEW_PR_TITLE_CHARS - 1).trimEnd()}…`;
}

function markdownText(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ') || '—';
  return normalized
    .replace(/\\/g, '\\\\')
    .replace(/([`*_[\]<>#])/g, '\\$1')
    .replace(/\|/g, '\\|');
}

function markdownCode(value: string): string {
  return value.replace(/[\r\n`]/g, '-');
}

function explicitAdrReferences(values: readonly string[]): string[] {
  return [...new Set(values.flatMap((value) => (
    value.match(/\bADR[- _]?\d{1,6}\b/gi) ?? []
  )).map((reference) => reference.toUpperCase().replace(/[ _]/g, '-')))].sort();
}

/** The EvalRuns of the highest attempt (the build actually at the gate). */
function latestAttemptRuns(runs: EvalRun[]): EvalRun[] {
  if (runs.length === 0) return [];
  const maxAttempt = Math.max(...runs.map((r) => r.attempt));
  return runs.filter((r) => r.attempt === maxAttempt);
}

// --- real backend (shells out; command seam keeps grounded CLI contracts testable) ----------

interface OpenPullRequest {
  number: number;
  url: string;
  title: string;
  body: string;
  headRefName: string;
  baseRefName: string;
  isCrossRepository: boolean;
}

function repositoryFromPullRequestUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`GitHub pull request returned an invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') {
    throw new Error(`GitHub pull request URL has a non-canonical origin: ${url}`);
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 4 || parts[2] !== 'pull') {
    throw new Error(`GitHub pull request URL has no canonical repository: ${url}`);
  }
  return canonicalGithubRepository(`${parts[0]}/${parts[1]}`);
}

function assertExpectedPrSemantics(repository: string, body: string): void {
  const identity = parseWorkIdentityMarker(body);
  if (!identity) {
    if (parsePullRequestClosingTarget(body)) {
      throw new Error(
        'an uncorrelated pull request must not contain an external closing target',
      );
    }
    return;
  }
  if (identity.repository !== repository) {
    throw new Error(
      `expected PR work repository ${identity.repository} does not match ${repository}`,
    );
  }
  const target = parsePullRequestClosingTarget(body);
  if (
    !target
    || target.repository !== identity.repository
    || target.issueNumber !== identity.issueNumber
  ) {
    throw new Error('expected PR closing target does not match its durable work identity');
  }
}

function validateMatchingPullRequest(
  match: OpenPullRequest,
  repository: string,
  expectedTitle: string,
  expectedBody: string,
): PrExternalRef {
  if (repositoryFromPullRequestUrl(match.url) !== repository) {
    throw new Error(`matching pull request is outside canonical repository ${repository}`);
  }
  const expectedIdentity = parseWorkIdentityMarker(expectedBody);
  const observedIdentity = parseWorkIdentityMarker(match.body);
  if (!expectedIdentity) {
    if (
      observedIdentity
      || parsePullRequestClosingTarget(expectedBody)
      || parsePullRequestClosingTarget(match.body)
      || match.title !== expectedTitle
      || match.body !== expectedBody
    ) {
      throw new Error(
        `existing PR #${match.number} does not exactly match the expected local work`,
      );
    }
    return {
      provider: 'github',
      repository,
      number: match.number,
      url: match.url,
    };
  }
  if (
    !observedIdentity
    || !sameProjectedWorkIdentity(expectedIdentity, observedIdentity)
  ) {
    throw new Error(
      `existing PR #${match.number} does not match the expected external Issue/release identity`,
    );
  }
  const expectedTarget = parsePullRequestClosingTarget(expectedBody);
  const observedTarget = parsePullRequestClosingTarget(match.body);
  if (
    !expectedTarget
    || !observedTarget
    || !samePullRequestClosingTarget(expectedTarget, observedTarget)
  ) {
    throw new Error(
      `existing PR #${match.number} does not match the expected PR closing target`,
    );
  }
  return {
    provider: 'github',
    repository,
    number: match.number,
    url: match.url,
  };
}

function matchingOpenPullRequest(
  command: GateCommandRunner,
  cwd: string,
  repoArgs: string[],
  repository: string,
  head: string,
  base: string,
  expectedTitle: string,
  expectedBody: string,
): PrExternalRef | null {
  const output = command('gh', [
    'pr', 'list', ...repoArgs,
    '--state', 'open',
    '--head', head,
    '--base', base,
    '--limit', '2',
    '--json', 'number,url,title,body,headRefName,baseRefName,isCrossRepository',
  ], cwd);
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) {
    throw new Error('gh pr list returned a non-array response');
  }
  const candidates = parsed.map((candidate): OpenPullRequest => {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error('gh pr list returned an invalid pull request');
    }
    const value = candidate as Record<string, unknown>;
    if (
      !Number.isInteger(value.number)
      || typeof value.url !== 'string'
      || typeof value.title !== 'string'
      || typeof value.body !== 'string'
      || typeof value.headRefName !== 'string'
      || typeof value.baseRefName !== 'string'
      || typeof value.isCrossRepository !== 'boolean'
    ) {
      throw new Error('gh pr list returned an invalid pull request');
    }
    return value as unknown as OpenPullRequest;
  });
  const matches = candidates.filter((candidate) =>
    candidate.headRefName === head
    && candidate.baseRefName === base
    && !candidate.isCrossRepository);
  if (matches.length > 1) {
    throw new Error(
      `multiple open pull requests match head "${head}" and base "${base}"`,
    );
  }
  const match = matches[0];
  return match
    ? validateMatchingPullRequest(
      match,
      repository,
      expectedTitle,
      expectedBody,
    )
    : null;
}

interface GithubTarget {
  repository: string;
  remote: string;
  repoArgs: string[];
}

/** Resolve only canonical github.com owner/repository remotes. */
function repositoryFromGitRemoteUrl(remoteUrl: string): string {
  const value = remoteUrl.trim();
  if (value.length === 0) {
    throw new Error('GitHub origin returned an invalid remote URL');
  }

  const scp = /^git@github\.com:([^/]+)\/(.+)$/.exec(value);
  if (scp) {
    const repository = scp[2]!.endsWith('.git')
      ? scp[2]!.slice(0, -4)
      : scp[2]!;
    return canonicalGithubRepository(`${scp[1]}/${repository}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`origin is not a canonical GitHub remote: ${value}`);
  }
  const supported = (
    parsed.protocol === 'https:'
    && parsed.username === ''
    && parsed.password === ''
  ) || (
    parsed.protocol === 'ssh:'
    && parsed.username === 'git'
    && parsed.password === ''
  );
  if (
    !supported
    || parsed.hostname.toLowerCase() !== 'github.com'
    || parsed.port !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    throw new Error(`origin is not a canonical GitHub remote: ${value}`);
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) {
    throw new Error(`origin is not a canonical GitHub repository: ${value}`);
  }
  const name = parts[1]!.endsWith('.git')
    ? parts[1]!.slice(0, -4)
    : parts[1]!;
  return canonicalGithubRepository(`${parts[0]}/${name}`);
}

function githubTarget(
  command: GateCommandRunner,
  cwd: string,
  configuredRepository: string | null,
): GithubTarget {
  const repository = configuredRepository ?? repositoryFromGitRemoteUrl(
    command('git', ['remote', 'get-url', 'origin'], cwd),
  );
  return {
    repository,
    remote: `https://github.com/${repository}.git`,
    repoArgs: ['--repo', repository],
  };
}

function sameGithubTarget(left: GithubTarget, right: GithubTarget): boolean {
  return left.repository === right.repository && left.remote === right.remote;
}

function remoteBranchExists(
  command: GateCommandRunner,
  cwd: string,
  remote: string,
  branch: string,
): boolean {
  const ref = `refs/heads/${branch}`;
  const output = command(
    'git',
    ['ls-remote', '--heads', remote, ref],
    cwd,
    { credentials: 'github' },
  ).trim();
  if (output === '') return false;
  const lines = output.split('\n').filter(Boolean);
  if (
    lines.length !== 1
    || !/^[0-9a-f]{40}\trefs\/heads\/.+$/i.test(lines[0]!)
    || !lines[0]!.endsWith(`\t${ref}`)
  ) {
    throw new Error(`git ls-remote returned an ambiguous branch identity for ${branch}`);
  }
  return true;
}

/** The production GhGateRunner: real `git push` + `gh` against the target repo's remote. */
export function realGhGateRunner(
  repository?: string,
  command: GateCommandRunner = run,
): GhGateRunner {
  const canonicalRepository = repository
    ? canonicalGithubRepository(repository)
    : null;
  const preflightTargets = new Map<string, GithubTarget>();
  return {
    preflightPr(cwd, args) {
      const target = githubTarget(command, cwd, canonicalRepository);
      assertExpectedPrSemantics(target.repository, args.body);
      if (args.existingRef?.repository) {
        if (
          canonicalGithubRepository(args.existingRef.repository)
          !== target.repository
        ) {
          throw new Error(
            `stored PR #${args.existingRef.number} belongs to another repository`,
          );
        }
      }
      if (
        args.existingRef
        && repositoryFromPullRequestUrl(args.existingRef.url)
          !== target.repository
      ) {
        throw new Error(
          `stored PR #${args.existingRef.number} URL belongs to another repository`,
        );
      }
      const existing = matchingOpenPullRequest(
        command,
        cwd,
        target.repoArgs,
        target.repository,
        args.head,
        args.base,
        args.title,
        args.body,
      );
      const branchExists = remoteBranchExists(
        command,
        cwd,
        target.remote,
        args.head,
      );
      if (existing) {
        if (!branchExists) {
          throw new Error(
            `existing PR #${existing.number} has no matching remote branch ${args.head}`,
          );
        }
        if (
          args.existingRef
          && args.existingRef.number !== existing.number
        ) {
          throw new Error(
            `stored PR #${args.existingRef.number} does not match existing PR #${existing.number}`,
          );
        }
        preflightTargets.set(cwd, target);
        return existing;
      }
      if (args.existingRef) {
        throw new Error(
          `stored PR #${args.existingRef.number} is not the unique open PR for ${args.head}`,
        );
      }
      if (branchExists) {
        throw new Error(
          `refusing to push ambiguous existing branch "${args.head}" without an exact correlated open PR`,
        );
      }
      preflightTargets.set(cwd, target);
      return null;
    },
    pushBranch(worktree, branch) {
      // Push an AgentOps-generated worktree HEAD to its stable remote PR branch.
      // Repository-discovered heads never reach this credential-bearing adapter.
      const expected = preflightTargets.get(worktree);
      if (!expected) {
        throw new Error('GitHub branch push requires a successful identity preflight');
      }
      const observed = githubTarget(command, worktree, canonicalRepository);
      if (!sameGithubTarget(expected, observed)) {
        throw new Error('GitHub origin changed after identity preflight');
      }
      pushGeneratedBranch(worktree, expected.remote, branch);
    },
    createPr(cwd, args) {
      const target = githubTarget(command, cwd, canonicalRepository);
      assertExpectedPrSemantics(target.repository, args.body);
      const existing = matchingOpenPullRequest(
        command,
        cwd,
        target.repoArgs,
        target.repository,
        args.head,
        args.base,
        args.title,
        args.body,
      );
      if (existing) return existing;

      const bodyFile = path.join(os.tmpdir(), `ao-gate-body-${args.head.replace(/\W+/g, '-')}.md`);
      fs.writeFileSync(bodyFile, args.body, 'utf8');
      try {
        try {
          command('gh', [
            'pr', 'create', ...target.repoArgs,
            '--base', args.base, '--head', args.head,
            '--title', args.title, '--body-file', bodyFile,
          ], cwd);
        } catch (createError) {
          // A matching PR may have appeared after the first lookup. Resolve
          // that exact identity; never infer it from the error text or URL.
          let raced: PrExternalRef | null = null;
          try {
            raced = matchingOpenPullRequest(
              command,
              cwd,
              target.repoArgs,
              target.repository,
              args.head,
              args.base,
              args.title,
              args.body,
            );
          } catch {
            throw createError;
          }
          if (raced) return raced;
          throw createError;
        }
      } finally {
        fs.rmSync(bodyFile, { force: true });
      }
      const created = matchingOpenPullRequest(
        command,
        cwd,
        target.repoArgs,
        target.repository,
        args.head,
        args.base,
        args.title,
        args.body,
      );
      if (!created) {
        throw new Error(
          `created pull request could not be resolved for head "${args.head}" and base "${args.base}"`,
        );
      }
      return created;
    },
    viewPr(cwd, prNumber) {
      const target = githubTarget(command, cwd, canonicalRepository);
      const out = command('gh', [
        'pr', 'view', String(prNumber), ...target.repoArgs, '--json', 'state',
      ], cwd);
      const state = String((JSON.parse(out) as { state: string }).state).toLowerCase();
      return state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'open';
    },
  };
}
