/**
 * The execution layer's outer control loop (ADR-0005 L1 / ADR-0006 G1-G3): drive
 * ai-managed issues through implement → panel → review-gate, and release only on a
 * recorded human decision. Deterministic harness code (DOM-execution-008): the poll
 * predicate, status routing, resume and gate are code; only `generate` (the artifact)
 * and the human decision are supplied from outside.
 *
 * This is a NEW entry point, additive to coordinator.runAll (the mock demo path that
 * auto-releases). The two never share a control path — runAll stays as-is.
 */

import {
  PR,
  approvePR,
  bindApprovalRevisionToPR,
  requireMutablePR,
  transitionPR,
  updatePR,
  type Issue,
  type Verdict,
  type EvalRun,
} from '../../domain/schema.js';
import type { HarnessConfig } from '../../config.js';
import type { RepairBrief } from '../../domain/artifact.js';
import { Store, nowISO } from '../../store/store.js';
import { makeRunner, type AgentRunner } from '../../agents/runner.js';
import { pollable } from './guard.js';
import { runPanel, aggregatePanelVerdict, type RunPanelOptions, type PanelResult } from '../panel.js';
import { buildPanelRepairBrief, toGenerateBrief } from '../repair.js';

/**
 * Route a panel verdict into the state machine (DOM-execution-007). The one rule that
 * matters: a panel `approve` does NOT auto-release — it advances to build-approved then
 * stops at the human review gate (needs-human-review, AC-LOOP-005). request_changes goes
 * back to the repair lane; needs_human is already surfaced by the panel.
 */
export function applyPanelVerdict(store: Store, issueId: string, verdict: Verdict): IssueStatusResult {
  const cur = store.getIssue(issueId)?.status;
  if (verdict === 'approve') {
    store.setStatus(issueId, 'build-approved');
    store.setStatus(issueId, 'needs-human-review'); // gate: wait for a human (G1)
  } else if (verdict === 'request_changes') {
    if (cur !== 'changes-requested') store.setStatus(issueId, 'changes-requested');
  } else if (cur !== 'needs-human-review') {
    store.setStatus(issueId, 'needs-human-review'); // needs_human (panel escalation)
  }
  return { issueId, status: store.getIssue(issueId)!.status };
}

export interface IssueStatusResult {
  issueId: string;
  status: string;
}

export type HumanDecision = 'approve' | 'reject';

export interface RecordDecisionResult {
  issueId: string;
  status: string;
  changed: boolean;
  labeledRunIds: string[];
}

/**
 * Record a human review decision at the gate (ARCH-execution-008, label harvest G3).
 * approve → released; reject → back to the repair lane. Either way the decision is written
 * onto the winning sample's perspective runs as `humanVerdict` — the evidence that lets the
 * harness later measure the panel's false-pass rate against real human judgement
 * (AC-LOOP-006/007). Idempotent: a decision applied to an already-released issue is a no-op
 * and never double-records (AC-LOOP-008).
 */
export function recordHumanDecision(store: Store, issueId: string, decision: HumanDecision): RecordDecisionResult {
  const issue = store.getIssue(issueId);
  if (!issue) throw new Error(`no such issue: ${issueId}`);
  if (issue.status === 'released') {
    return { issueId, status: issue.status, changed: false, labeledRunIds: [] }; // idempotent
  }

  const label: Verdict = decision === 'approve' ? 'approve' : 'request_changes';
  const winning = winningSampleRuns(store, issueId);
  for (const r of winning) r.humanVerdict = label;

  if (decision === 'approve') {
    store.setStatus(issueId, 'released');
  } else if (issue.status !== 'changes-requested') {
    store.setStatus(issueId, 'changes-requested');
  }
  return { issueId, status: store.getIssue(issueId)!.status, changed: true, labeledRunIds: winning.map((r) => r.id) };
}

/** The runs of the sample whose panel aggregate approved — the build the human is judging. */
function winningSampleRuns(store: Store, issueId: string): EvalRun[] {
  const byGroup = new Map<string, EvalRun[]>();
  for (const r of store.runsForIssue(issueId)) {
    const key = `${r.prId}|${r.attempt}`;
    const arr = byGroup.get(key) ?? [];
    arr.push(r);
    byGroup.set(key, arr);
  }
  for (const runs of byGroup.values()) {
    if (aggregatePanelVerdict(runs) === 'approve') return runs;
  }
  return [];
}

export interface DriveResult {
  issueId: string;
  prId: string;
  verdict: Verdict;
  status: string;
  gateFailed: boolean;
  escalated: boolean;
  /** How many generate→panel attempts ran (1 = converged/failed first try). */
  attempts: number;
  /** True when the loop exhausted its bound without converging (escalated to human review). */
  exhausted: boolean;
  /** best-of-N: how many independent samples were driven (absent/1 for the single-sample default). */
  sampleCount?: number;
}

export interface DriveOptions {
  runner?: AgentRunner;
  panel?: RunPanelOptions;
}

/** What producing one attempt yields: a graded panel, or a stuck generator (live-only). */
export interface AttemptOutcome {
  /** The generator could not finish this attempt (live: a stuck/timed-out session). */
  stuck?: boolean;
  /** The graded evaluator panel for this attempt (absent iff `stuck`). */
  panel?: PanelResult;
}

/** Produce one attempt's build+grade. `brief` is null on attempt 1, a repair brief thereafter. */
export type ProduceAttempt = (attempt: number, brief: RepairBrief | null) => Promise<AttemptOutcome>;

/** The loop-derived fields of a DriveResult (everything but the issue/PR identity). */
export type LoopOutcome = Omit<DriveResult, 'issueId' | 'prId'>;

/**
 * The bounded repair loop, shared by the mock (`driveIssueOnce`) and live (`driveIssueLive`)
 * drives: generate → panel → (repair → generate → panel)* until it converges or the bound is
 * spent (repair-loop spec). It is pure orchestration (DOM-execution-008) — it never builds or
 * grades anything itself; `produce` supplies each attempt's artifact+panel, so the mock and the
 * real-session backend run the identical control flow.
 *
 * On approve it advances to the review gate (AC-REPAIR-002); on request_changes it feeds the
 * cross-perspective findings into the next attempt as a repair brief (AC-REPAIR-001), each attempt
 * keeping its own EvalRuns (AC-REPAIR-003). Exhausting config.maxRepairs+1 attempts without
 * converging escalates to needs-human-review — never an infinite loop, never a silent pass
 * (AC-REPAIR-004). A `stuck` attempt (live liveness surfacing) escalates immediately and keeps the
 * session alive for a human (ARCH-execution-014) — also never a silent grade.
 *
 * `manageIssueStatus` (default true) owns the issue's status transitions. Best-of-N drives several
 * samples through this loop for one issue and must apply the ISSUE's terminal status once, at the
 * winner level — so it sets `false` and the loop touches only PR status + verdict, leaving the
 * issue status for the caller (the resting state must reflect the winner, not the last sample).
 */
export async function runBoundedRepairLoop(
  store: Store,
  config: HarnessConfig,
  issueId: string,
  pr: PR,
  produce: ProduceAttempt,
  opts: {
    log?: (m: string) => void;
    manageIssueStatus?: boolean;
    /** Resume an existing PR without reusing an old attempt identity. */
    startAttempt?: number;
    /** Blocking GitHub review/check evidence that triggered this resumed turn. */
    initialRepairBrief?: RepairBrief | null;
  } = {},
): Promise<LoopOutcome> {
  const log = opts.log ?? (() => {});
  const manage = opts.manageIssueStatus ?? true;
  const startAttempt = opts.startAttempt ?? 1;
  const maxAttempts = startAttempt + config.maxRepairs;
  let repairBrief: RepairBrief | null = opts.initialRepairBrief ?? null;
  let lastVerdict: Verdict = 'request_changes';
  let gateFailed = false;
  let panelEscalated = false;
  let stuck = false;
  let currentPr = pr;

  for (let attempt = startAttempt; attempt <= maxAttempts; attempt++) {
    if (manage && attempt > startAttempt) {
      store.setStatus(issueId, 'generation-in-progress'); // changes-requested -> generation (repair)
    }
    currentPr = store.replacePR(updatePR(requireMutablePR(currentPr), { attempts: attempt }));

    const outcome = await produce(attempt, repairBrief);

    if (outcome.stuck || !outcome.panel) {
      // Liveness surfacing (ARCH-execution-014): keep the session alive, escalate, stop the loop.
      // No panel ran, so the aggregate outcome is "needs a human", not a changes-requested verdict.
      stuck = true;
      lastVerdict = 'needs_human';
      currentPr = store.replacePR(transitionPR(currentPr, { status: 'changes-requested' }));
      if (manage && store.getIssue(issueId)!.status !== 'needs-human-review') store.setStatus(issueId, 'needs-human-review');
      break;
    }

    const panel = outcome.panel;
    lastVerdict = panel.verdict;
    gateFailed = panel.gateFailed;

    if (panel.escalated) {
      panelEscalated = true; // panel already sent the issue to needs-human-review
      break;
    }
    if (panel.verdict === 'approve') {
      if (manage) applyPanelVerdict(store, issueId, 'approve'); // build-approved -> needs-human-review (gate)
      // Local/store gating has no immutable GitHub head to approve. Only the
      // issue advances to its human gate; the PR remains open until revision
      // identity exists.
      const currentRevision = currentPr.headSha
        ? store.revisionForHead(currentPr.id, currentPr.headSha)
        : undefined;
      currentPr = currentRevision
        && (currentRevision.status === 'reviewing' || currentRevision.status === 'approved')
        ? store.replacePR(approvePR(
          currentPr,
          bindApprovalRevisionToPR(currentPr, currentRevision),
        ))
        : store.replacePR(transitionPR(currentPr, { status: 'open' }));
      break;
    }
    // request_changes: route back and carry this attempt's findings into the next generate.
    if (manage) applyPanelVerdict(store, issueId, 'request_changes');
    currentPr = store.replacePR(transitionPR(currentPr, { status: 'changes-requested' }));
    repairBrief = toGenerateBrief(buildPanelRepairBrief(panel.runs));
    if (attempt < maxAttempts) log(`  ↻ ${issueId}: request_changes → repair (${repairBrief.instructions.length} fix(es))`);
  }

  // Bounded escalation (AC-REPAIR-004): exhausted the loop without converging -> human review.
  const converged = lastVerdict === 'approve';
  const exhausted = !converged && !panelEscalated && !stuck;
  if (manage && exhausted && store.getIssue(issueId)!.status !== 'needs-human-review') {
    store.setStatus(issueId, 'needs-human-review');
  }

  currentPr = store.replacePR(updatePR(requireMutablePR(currentPr), {}));
  return {
    verdict: lastVerdict,
    status: store.getIssue(issueId)!.status,
    gateFailed,
    escalated: panelEscalated || stuck,
    attempts: currentPr.attempts,
    exhausted,
  };
}

/** One best-of-N sample's outcome — the loop result plus which sample it was and its build checkout. */
export interface SampleOutcome extends LoopOutcome {
  sampleIndex: number;
  prId: string;
  approved: boolean;
  /** The build checkout to project at the gate if this sample wins (live backend; null when none). */
  worktree: string | null;
}

/**
 * Best-of-N orchestration (ADR-0006 E5): drive up to `n` independent samples of one issue and pick
 * the winner (the first to reach an approve verdict). Pure control flow over a `runSample` seam —
 * the mock and live backends plug their per-sample driver in, exactly like `produce` for the repair
 * loop. `measure` is the ship-vs-measure switch: default (false) is FIRST-APPROVE-STOP — stop as
 * soon as a sample approves (cheapest reliable build). `measure: true` runs ALL n samples to
 * completion regardless, so the Eval DB has the full sample set pass@k / pass^k are computed from
 * (a truncated set makes pass^k meaningless). The winner is still the first approver.
 */
export async function runBestOfN(
  n: number,
  measure: boolean,
  runSample: (sampleIndex: number) => Promise<SampleOutcome>,
): Promise<{ samples: SampleOutcome[]; winner: SampleOutcome | null }> {
  const samples: SampleOutcome[] = [];
  for (let s = 0; s < Math.max(1, n); s++) {
    const outcome = await runSample(s);
    samples.push(outcome);
    if (outcome.approved && !measure) break; // first-approve-stop (default): don't pay for more
  }
  return { samples, winner: samples.find((o) => o.approved) ?? null };
}

/**
 * Drive ONE contract-drafted, ai-managed issue through the bounded repair loop with the MOCK
 * backend (deterministic runner + deterministic graders). Thin wrapper over runBoundedRepairLoop:
 * it only supplies the per-attempt production (runner.generate → runPanel). After this the issue
 * has left `contract-drafted`, so a re-poll never re-drives it (AC-LOOP-003/004).
 */
export async function driveIssueOnce(store: Store, config: HarnessConfig, runner: AgentRunner, issue: Issue, opts: DriveOptions = {}): Promise<DriveResult> {
  const contract = issue.contract;
  if (!contract) throw new Error(`issue ${issue.id} has no contract`);

  store.setStatus(issue.id, 'ready-for-generation');
  store.setStatus(issue.id, 'generation-in-progress');
  const createdPr = store.addPR(
    PR.parse({
      id: store.nextId('PR'),
      issueId: issue.id,
      branch: `agent/${issue.id.toLowerCase()}-s0`,
      baseBranch: config.baseBranch,
      generator: runner.agent,
      attempts: 0,
      status: 'open',
      createdAt: nowISO(),
      updatedAt: nowISO(),
    }),
  );
  const pr = store.db.prs.find((candidate) => candidate.id === createdPr.id)!;

  const loop = await runBoundedRepairLoop(store, config, issue.id, pr, async (attempt, repairBrief) => {
    const artifact = await runner.generate({ issue, contract, sampleIndex: 0, attempt, repairBrief });
    store.setStatus(issue.id, 'ready-for-evaluation');
    store.setStatus(issue.id, 'evaluation-in-progress');
    const panel = runPanel(
      store,
      config,
      { issueId: issue.id, prId: pr.id, contract, artifact, sampleIndex: 0, attempt, agent: runner.agent, featureArea: issue.area },
      opts.panel,
    );
    return { panel };
  });

  return { issueId: issue.id, prId: pr.id, ...loop };
}

/**
 * One turn of the watch loop (ARCH-execution-001): drain the ai-managed queue once. Only
 * `contract-drafted` + assigned issues are pollable (AC-LOOP-002), so unassigned / others'
 * issues are never touched, and issues already past the gate are never re-driven.
 */
export async function driveOnce(store: Store, config: HarnessConfig, opts: DriveOptions = {}): Promise<DriveResult[]> {
  const runner = opts.runner ?? makeRunner(config);
  const results: DriveResult[] = [];
  for (const issue of pollable(store, config)) {
    results.push(await driveIssueOnce(store, config, runner, issue, opts));
  }
  return results;
}

/**
 * The watch daemon: run-once, persist, repeat (L1). Deliberately thin — all the tested
 * behaviour is in driveOnce; this only adds the poll cadence and the store checkpoint so a
 * crash resumes from the last persisted state.
 */
export async function watch(store: Store, config: HarnessConfig, opts: DriveOptions & { intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<never> {
  const intervalMs = opts.intervalMs ?? 5000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    await driveOnce(store, config, opts);
    store.save();
    await sleep(intervalMs);
  }
}
