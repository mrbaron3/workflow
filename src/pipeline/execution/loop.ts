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

import { PR, type Issue, type Verdict, type EvalRun } from '../../domain/schema.js';
import type { HarnessConfig } from '../../config.js';
import type { BuildArtifact } from '../../domain/artifact.js';
import { Store, nowISO } from '../../store/store.js';
import { makeRunner, type AgentRunner } from '../../agents/runner.js';
import { pollable } from './guard.js';
import { runPanel, aggregatePanelVerdict, type RunPanelOptions } from '../panel.js';

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
}

export interface DriveOptions {
  runner?: AgentRunner;
  panel?: RunPanelOptions;
}

/**
 * Drive ONE contract-drafted, ai-managed issue: walk it to evaluation, generate a build,
 * convene the panel, and route the verdict through the gate. Single sample / single attempt
 * (the repair loop is a separate slice). After this the issue has left `contract-drafted`,
 * so a re-poll never picks it up again — that is what makes the drive re-entrant and
 * resumable from store state alone (AC-LOOP-003/004).
 */
export async function driveIssueOnce(store: Store, config: HarnessConfig, runner: AgentRunner, issue: Issue, opts: DriveOptions = {}): Promise<DriveResult> {
  const contract = issue.contract;
  if (!contract) throw new Error(`issue ${issue.id} has no contract`);

  store.setStatus(issue.id, 'ready-for-generation');
  store.setStatus(issue.id, 'generation-in-progress');
  const pr = store.addPR(
    PR.parse({
      id: store.nextId('PR'),
      issueId: issue.id,
      branch: `agent/${issue.id.toLowerCase()}-s0`,
      baseBranch: config.baseBranch,
      generator: runner.agent,
      attempts: 1,
      status: 'open',
      createdAt: nowISO(),
      updatedAt: nowISO(),
    }),
  );

  const artifact: BuildArtifact = await runner.generate({ issue, contract, sampleIndex: 0, attempt: 1, repairBrief: null });

  store.setStatus(issue.id, 'ready-for-evaluation');
  store.setStatus(issue.id, 'evaluation-in-progress');

  const panel = runPanel(
    store,
    config,
    { issueId: issue.id, prId: pr.id, contract, artifact, sampleIndex: 0, attempt: 1, agent: runner.agent, featureArea: issue.area },
    opts.panel,
  );

  // The panel already sent the issue to needs-human-review if it escalated; otherwise route here.
  if (!panel.escalated) applyPanelVerdict(store, issue.id, panel.verdict);
  pr.status = panel.verdict === 'approve' ? 'approved' : 'changes-requested';
  pr.updatedAt = nowISO();

  return { issueId: issue.id, prId: pr.id, verdict: panel.verdict, status: store.getIssue(issue.id)!.status, gateFailed: panel.gateFailed, escalated: panel.escalated };
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
