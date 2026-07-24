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
import { runCommand as run } from './command.js';
import { observePrRevision } from './pr-native.js';

/** A GitHub PR's lifecycle state, normalised from `gh pr view --json state`. */
export type GhPrState = 'open' | 'merged' | 'closed';

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
  /** Push `branch` (checked out in `worktree`) to the remote so a PR can target it. */
  pushBranch(worktree: string, branch: string): void;
  /** Open a PR from `head` into `base`; return its number + url. `cwd` is a checkout with the remote. */
  createPr(cwd: string, args: { base: string; head: string; title: string; body: string }): PrExternalRef;
  /** The current lifecycle state of PR `number`. `cwd` is any checkout of the target repo. */
  viewPr(cwd: string, prNumber: number): GhPrState;
}

/** Stable PR identity: any local repair branch publishes its HEAD to the original GitHub head. */
export function prHeadRefspec(branch: string): string {
  return `HEAD:refs/heads/${branch}`;
}

export interface OpenGateInput {
  pr: PR;
  /** The checkout whose branch is pushed and from which the PR is opened. */
  worktree: string;
  title: string;
}

export interface ProjectReviewRevisionInput extends OpenGateInput {
  headSha: string;
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
) {
  let projectedPr = store.getPR(input.pr.id) ?? input.pr;
  const revision = observePrRevision(store, projectedPr, input.headSha);
  if ((config.gate?.backend ?? 'store') !== 'github') return revision;

  runner.pushBranch(input.worktree, input.pr.branch);
  projectedPr = store.getPR(input.pr.id) ?? projectedPr;
  if (!projectedPr.externalRef) {
    const base = config.gate?.baseBranch ?? config.baseBranch;
    const ref = PrExternalRef.parse(runner.createPr(input.worktree, {
      base,
      head: input.pr.branch,
      title: input.title,
      body: renderReviewPrBody(store, input.pr.issueId),
    }));
    projectedPr = store.replacePR(updatePR(requireMutablePR(projectedPr), { externalRef: ref }));
    log(`  ⇪ ${input.pr.issueId}: opened review PR ${ref.url} @ ${input.headSha.slice(0, 12)}`);
  } else {
    log(
      `  ⇪ ${input.pr.issueId}: pushed repair revision `
      + `${input.headSha.slice(0, 12)} to PR #${projectedPr.externalRef!.number}`,
    );
  }
  store.replacePR(updatePR(requireMutablePR(projectedPr), {}));
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
  runner.pushBranch(input.worktree, input.pr.branch);
  const ref = PrExternalRef.parse(runner.createPr(input.worktree, { base, head: input.pr.branch, title: input.title, body }));
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
    const relation = source.storeIssueIds.length === 1 ? 'Closes' : 'Refs';
    lines.push(``, `${relation} ${source.snapshot.repository}#${source.snapshot.number}`);
  }
  return lines.join('\n');
}

/** Initial body for a PR created before its first perspective review. */
export function renderReviewPrBody(store: Store, issueId: string): string {
  const lines = [
    `このPRはAgentOpsのcurrent-headレビュー・修正ループで処理されます。`,
    `各head SHAについて全必須観点・checks・未解決blocking threadを再評価し、`,
    `ゲート通過時だけexpected SHA付きで自動mergeします。`,
  ];
  const source = store.db.intakeRecords.find((record) => record.storeIssueIds.includes(issueId));
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

// --- real backend (shells out; grounded only, never exercised in unit tests) ----------------

/** The production GhGateRunner: real `git push` + `gh` against the target repo's remote. */
export function realGhGateRunner(): GhGateRunner {
  return {
    pushBranch(worktree, branch) {
      // Push the reviewed worktree HEAD to the PR's remote branch. Repository-discovered
      // PRs use an AgentOps-local repair branch, while their GitHub head branch keeps its
      // original name; HEAD:<branch> preserves that stable external PR identity.
      run('git', [
        '-C',
        worktree,
        'push',
        '--force-with-lease',
        '-u',
        'origin',
        prHeadRefspec(branch),
      ], worktree);
    },
    createPr(cwd, args) {
      const bodyFile = path.join(os.tmpdir(), `ao-gate-body-${args.head.replace(/\W+/g, '-')}.md`);
      fs.writeFileSync(bodyFile, args.body, 'utf8');
      try {
        run('gh', ['pr', 'create', '--base', args.base, '--head', args.head, '--title', args.title, '--body-file', bodyFile], cwd);
      } finally {
        fs.rmSync(bodyFile, { force: true });
      }
      // read back number + url (gh pr create prints only the url; --json gives both)
      const out = run('gh', ['pr', 'view', args.head, '--json', 'number,url'], cwd);
      const json = JSON.parse(out) as { number: number; url: string };
      return { provider: 'github', number: json.number, url: json.url };
    },
    viewPr(cwd, prNumber) {
      const out = run('gh', ['pr', 'view', String(prNumber), '--json', 'state'], cwd);
      const state = String((JSON.parse(out) as { state: string }).state).toLowerCase();
      return state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'open';
    },
  };
}
