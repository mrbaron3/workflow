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
  /** External mutation identity. null/absent only for local sandbox work. */
  workIdentity?: ExternalWorkIdentity | null;
  sampleIndex?: number;
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
  const body = renderReviewPrBody(store, input.pr.issueId, projectedIdentity);
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
): string {
  const lines = [
    `このPRはAgentOpsのcurrent-headレビュー・修正ループで処理されます。`,
    `各head SHAについて全必須観点・checks・未解決blocking threadを再評価し、`,
    `ゲート通過時だけexpected SHA付きで自動mergeします。`,
  ];
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
    lines.push('', renderWorkIdentityMarker(effectiveIdentity));
  }
  if (source) {
    const relation = source.storeIssueIds.length === 1 ? 'Closes' : 'Refs';
    lines.push('', `${relation} ${source.snapshot.repository}#${source.snapshot.number}`);
  }
  return lines.join('\n');
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
    throw new Error(
      'refusing to reuse a pull request without an expected durable work identity',
    );
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
  expectedBody: string,
): PrExternalRef {
  if (repositoryFromPullRequestUrl(match.url) !== repository) {
    throw new Error(`matching pull request is outside canonical repository ${repository}`);
  }
  const expectedIdentity = parseWorkIdentityMarker(expectedBody);
  const observedIdentity = parseWorkIdentityMarker(match.body);
  if (
    !expectedIdentity
    || !observedIdentity
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
  expectedBody: string,
): PrExternalRef | null {
  const output = command('gh', [
    'pr', 'list', ...repoArgs,
    '--state', 'open',
    '--head', head,
    '--base', base,
    '--limit', '2',
    '--json', 'number,url,body,headRefName,baseRefName,isCrossRepository',
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
    ? validateMatchingPullRequest(match, repository, expectedBody)
    : null;
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
  const remote = repository
    ? `https://github.com/${canonicalRepository}.git`
    : 'origin';
  const repoArgs = canonicalRepository ? ['--repo', canonicalRepository] : [];
  return {
    preflightPr(cwd, args) {
      if (!canonicalRepository) {
        throw new Error(
          'GitHub PR identity preflight requires an explicit canonical repository',
        );
      }
      assertExpectedPrSemantics(canonicalRepository, args.body);
      if (args.existingRef?.repository) {
        if (
          canonicalGithubRepository(args.existingRef.repository)
          !== canonicalRepository
        ) {
          throw new Error(
            `stored PR #${args.existingRef.number} belongs to another repository`,
          );
        }
      }
      if (
        args.existingRef
        && repositoryFromPullRequestUrl(args.existingRef.url)
          !== canonicalRepository
      ) {
        throw new Error(
          `stored PR #${args.existingRef.number} URL belongs to another repository`,
        );
      }
      const existing = matchingOpenPullRequest(
        command,
        cwd,
        repoArgs,
        canonicalRepository,
        args.head,
        args.base,
        args.body,
      );
      const branchExists = remoteBranchExists(
        command,
        cwd,
        remote,
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
      return null;
    },
    pushBranch(worktree, branch) {
      // Push an AgentOps-generated worktree HEAD to its stable remote PR branch.
      // Repository-discovered heads never reach this credential-bearing adapter.
      pushGeneratedBranch(worktree, remote, branch);
    },
    createPr(cwd, args) {
      if (!canonicalRepository) {
        throw new Error('GitHub PR creation requires an explicit canonical repository');
      }
      assertExpectedPrSemantics(canonicalRepository, args.body);
      const existing = matchingOpenPullRequest(
        command,
        cwd,
        repoArgs,
        canonicalRepository,
        args.head,
        args.base,
        args.body,
      );
      if (existing) return existing;

      const bodyFile = path.join(os.tmpdir(), `ao-gate-body-${args.head.replace(/\W+/g, '-')}.md`);
      fs.writeFileSync(bodyFile, args.body, 'utf8');
      try {
        try {
          command('gh', [
            'pr', 'create', ...repoArgs,
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
              repoArgs,
              canonicalRepository,
              args.head,
              args.base,
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
        repoArgs,
        canonicalRepository,
        args.head,
        args.base,
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
      const out = command('gh', [
        'pr', 'view', String(prNumber), ...repoArgs, '--json', 'state',
      ], cwd);
      const state = String((JSON.parse(out) as { state: string }).state).toLowerCase();
      return state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'open';
    },
  };
}
