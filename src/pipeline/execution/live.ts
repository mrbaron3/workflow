/**
 * The live execution loop: the real-backend wiring of the deterministic drive. Where
 * driveIssueOnce uses the mock runner + deterministic graders, this drives REAL Claude
 * sessions and grounds every gate in real tsc/vitest and real perspective reviews:
 *
 *   generator session → grounded BuildArtifact (real tsc/vitest)
 *     → six read-only perspective sessions write findings.json
 *       → runPanel grades from those files (sessionBackedGrader) + deterministic functionality
 *         → applyPanelVerdict routes to the human gate or the repair lane
 *
 * The orchestration (poll / dispatch / grade / gate) stays deterministic code
 * (ARCH-execution-011); only the sessions inside are non-deterministic. Not unit-tested —
 * it drives live tmux + Claude; the seams it composes are each tested on their own.
 */

import path from 'node:path';
import type { Issue } from '../../domain/schema.js';
import { resolveConcurrentIssueCap, type HarnessConfig } from '../../config.js';
import { Store, nowISO } from '../../store/store.js';
import { PR, TurnRecord } from '../../domain/schema.js';
import { recordAgentInvocation } from '../../agents/invocation.js';
import { resolveAgentRoute, resolvedGeneratorProvider } from '../../agents/routing.js';
import { pollable, blockedByDependencies, formatBlockedLine } from './guard.js';
import { mapPool } from './pool.js';
import { runGeneratorSession, sampleKey } from './session.js';
import { groundArtifact } from './grade.js';
import { runPerspectiveSessions, sessionBackedGrader, type PriorFinding } from './perspective-session.js';
import { runPanel, PERSPECTIVES, type PerspectiveSpec } from '../panel.js';
import { runBoundedRepairLoop, runBestOfN, applyPanelVerdict, type DriveResult, type SampleOutcome } from './loop.js';
import { openGate, realGhGateRunner, type GhGateRunner } from './gate.js';
import { improveTick } from '../improve.js';

export interface LiveOptions {
  /** Which lenses to convene (default: all 7). Reduce it for a cheap smoke. */
  perspectives?: PerspectiveSpec[];
  /** Gate backend runner (github only). Injectable for tests; defaults to the real `gh` runner. */
  gateRunner?: GhGateRunner;
  /** Best-of-N: independent samples to drive per issue (default config.samples; real default = 1). */
  samples?: number;
  /** Measurement run: drive ALL samples to completion for pass@k / pass^k, not first-approve-stop (E5). */
  measure?: boolean;
  /**
   * Injectable issue-driver for one queued issue (default: the real `driveIssueLive`).
   * ADDITIVE seam (ISSUE-0019): it makes the turn's concurrency scheduling decidable
   * without tmux — an injected worker records start/finish so overlap, cap adherence and
   * dependency exclusion are observable — while the real path stays byte-for-byte the same.
   */
  driveIssue?: (issue: Issue) => Promise<DriveResult>;
}

/**
 * The store→prior-findings selection for a re-review (ISSUE-0009), extracted pure like
 * collectFindings (AC-LIVE-003) so the deterministic sub-logic is pinned by unit tests, not
 * buried in the tmux orchestration: each lens is handed ONLY its own findings from the
 * IMMEDIATELY previous attempt of THIS PR, keyed by lens. perspective=null gate runs carry
 * no lens and are excluded; attempt 1 (no previous attempt) selects nothing, so every lens
 * keeps its first-review prompt.
 */
export function priorFindingsByLens(store: Store, prId: string, attempt: number): Record<string, readonly PriorFinding[]> {
  return Object.fromEntries(
    store.db.evalRuns
      .filter((r) => r.prId === prId && r.attempt === attempt - 1 && r.perspective !== null)
      .map((r) => [r.perspective!, r.findings]),
  );
}

/**
 * Drive ONE live sample of an issue: (generate → ground → panel)* bounded repair loop, in its own
 * worktree/branch `agent/<issue>-s<n>`. `manageIssueStatus` is false under best-of-N (>1 sample)
 * so the issue's terminal status is applied once by the caller at the winner level, not per sample.
 */
async function runLiveSample(
  store: Store, config: HarnessConfig, issue: Issue, sampleIndex: number,
  harnessRoot: string, opts: LiveOptions & { manageIssueStatus: boolean }, log: (m: string) => void,
): Promise<SampleOutcome> {
  const contract = issue.contract!;
  const target = config.target!;
  const perspectives = opts.perspectives ?? PERSPECTIVES;
  const issueKey = sampleKey(issue.id, sampleIndex);
  const maxAttempts = config.maxRepairs + 1;
  const manageIssueStatus = opts.manageIssueStatus;
  const generatorRoute = resolveAgentRoute(config, 'generator');

  const pr = store.addPR(
    PR.parse({
      id: store.nextId('PR'), issueId: issue.id, branch: `agent/${issueKey}`,
      baseBranch: config.baseBranch, generator: generatorRoute.provider, attempts: 0, status: 'open',
      createdAt: nowISO(), updatedAt: nowISO(),
    }),
  );
  let worktree: string | null = null; // the last completed attempt's checkout = the build at the gate

  const loop = await runBoundedRepairLoop(store, config, issue.id, pr, async (attempt, repairBrief) => {
    // 1. real generator session — carries the repair brief on attempt > 1 and reuses the worktree
    log(`▶ ${issue.id} s${sampleIndex}: generator session (attempt ${attempt}/${maxAttempts})`);
    const sess = await runGeneratorSession(config, { issue, contract, sampleIndex, attempt, repairBrief }, harnessRoot, log);
    // Persist the actual runtime provider separately from its model/routing intent. This replaces
    // new PromptRecord writes; legacy promptRecords remain readable but are never dual-written.
    recordAgentInvocation(store, {
      subjectId: issue.id, issueId: issue.id, prId: pr.id, sampleIndex, attempt,
      role: 'generator', perspective: null, provider: sess.provider,
      model: sess.model, outcome: sess.outcome, prompt: sess.prompt,
    });
    if (sess.outcome !== 'completed') {
      log(`  ⚠ ${issue.id} s${sampleIndex}: generator ${sess.outcome} — escalating, session kept alive`);
      return { stuck: true };
    }
    worktree = sess.worktree;
    if (manageIssueStatus) {
      store.setStatus(issue.id, 'ready-for-evaluation');
      store.setStatus(issue.id, 'evaluation-in-progress');
    }

    // 2. ground the checkout with real graders (real tsc/vitest)
    const artifact = groundArtifact({ contract, target, worktree: sess.worktree, branch: sess.branch, changed: sess.changed, issueId: issue.id });

    // 3. real read-only perspective sessions — each in its own detached worktree of the committed
    //    build (isolated + concurrent), collecting findings.json into the generator worktree's evalRoot.
    //    A re-review (attempt > 1) hands each lens its OWN previous-attempt findings so the reviewer
    //    attests lineage (persisted/new) per finding — never inferred downstream (ISSUE-0009).
    const priorFindings = priorFindingsByLens(store, pr.id, attempt);
    const panelSessions = await runPerspectiveSessions(
      config,
      {
        worktree: sess.worktree,
        contract,
        perspectives,
        issueKey,
        repo: path.resolve(harnessRoot, target.repo),
        buildRef: sess.branch,
        priorFindings,
        uiDesign: issue.uiDesign,
      },
      log,
    );
    const invocationKeys = Object.fromEntries(
      panelSessions.invocations.map((invocation) => {
        const record = recordAgentInvocation(store, {
          subjectId: issue.id, issueId: issue.id, prId: pr.id, sampleIndex, attempt,
          ...invocation,
        });
        return [invocation.perspective, record.invocationKey];
      }),
    );

    // 4. panel grades from the findings.json files (missing/broken -> escalate); functionality is deterministic
    const panel = runPanel(
      store, config,
      {
        issueId: issue.id, prId: pr.id, contract, artifact, sampleIndex, attempt,
        agent: sess.provider, invocationKeys, featureArea: issue.area,
      },
      { perspectives, grader: sessionBackedGrader(panelSessions.evalRoot) },
    );
    return { panel };
  }, { log, manageIssueStatus });

  return { ...loop, sampleIndex, prId: pr.id, approved: loop.verdict === 'approve', worktree };
}

/**
 * Drive ONE ai-managed issue through best-of-N live samples → the review gate (ADR-0006 E5). Each
 * sample is a real generator session grounded in real tsc/vitest and reviewed by real read-only
 * perspective sessions, bounded by config.maxRepairs+1 with cross-perspective repair (AC-REPAIR-*).
 * Default is one sample, first-approve-stop; opts.measure runs all opts.samples for pass@k/pass^k.
 * The WINNING sample (first to approve) is projected to the gate; a stuck/exhausted issue with no
 * approver escalates to needs-human-review (session kept alive). The seams are each unit-tested;
 * this orchestration drives live tmux + Claude and is not.
 */
export async function driveIssueLive(
  store: Store,
  config: HarnessConfig,
  issue: Issue,
  harnessRoot: string = process.cwd(),
  opts: LiveOptions = {},
  log: (m: string) => void = () => {},
): Promise<DriveResult> {
  if (!issue.contract) throw new Error(`${issue.id} has no contract`);
  if (!config.target) throw new Error('driveIssueLive requires config.target (a real repo)');
  const n = Math.max(1, opts.samples ?? config.samples);
  const measure = opts.measure ?? false;
  const single = n === 1; // single sample keeps the loop's own status management (unchanged behaviour)

  store.setStatus(issue.id, 'ready-for-generation');
  store.setStatus(issue.id, 'generation-in-progress');

  const { samples, winner } = await runBestOfN(n, measure, (s) =>
    runLiveSample(store, config, issue, s, harnessRoot, { ...opts, manageIssueStatus: single }, log));

  // Terminal issue status. Single-sample already had it managed inside the loop; best-of-N applies
  // it once here so the resting state reflects the WINNER, not whichever sample happened to run last.
  if (!single) {
    if (winner) {
      store.setStatus(issue.id, 'ready-for-evaluation');
      store.setStatus(issue.id, 'evaluation-in-progress');
      applyPanelVerdict(store, issue.id, 'approve'); // build-approved -> needs-human-review (gate)
    } else if (store.getIssue(issue.id)!.status !== 'needs-human-review') {
      store.setStatus(issue.id, 'needs-human-review'); // no sample converged -> escalate
    }
  }

  // Project the winning build to the gate UI (ADR-0006 G1). No-op for the store backend.
  if (winner?.worktree && (config.gate?.backend ?? 'store') === 'github') {
    const pr = store.getPR(winner.prId)!;
    openGate(store, config, { pr, worktree: winner.worktree, title: `${issue.id}: ${issue.title}` }, opts.gateRunner ?? realGhGateRunner(), log);
  }

  const status = store.getIssue(issue.id)!.status;
  const chosen = winner ?? samples[samples.length - 1]!; // the winner, else the last sample tried
  log(`  = ${issue.id}: ${samples.length} sample(s)${measure ? ' [measure]' : ''}, ${winner ? `winner s${winner.sampleIndex}` : 'none approved'} → ${status}`);
  return {
    issueId: issue.id, prId: chosen.prId, verdict: chosen.verdict, status,
    gateFailed: chosen.gateFailed, escalated: chosen.escalated, attempts: chosen.attempts,
    exhausted: chosen.exhausted, sampleCount: samples.length,
  };
}

/** One live turn over the ai-managed queue (the watch daemon's live run-once). */
export async function runLoopLive(
  store: Store, config: HarnessConfig, harnessRoot: string = process.cwd(),
  opts: LiveOptions = {}, log: (m: string) => void = () => {},
): Promise<DriveResult[]> {
  const queue = pollable(store, config);
  const cap = resolveConcurrentIssueCap(config);
  log(`queue: ${queue.length} ai-managed issue(s) [generator=${resolvedGeneratorProvider(config)}, cap=${cap}]`);
  // Dependency blocks are surfaced every turn (AC-DAG-001): an issue held back by the
  // guard names what it waits on in the log — it never just vanishes from the queue.
  // Under parallelism this stays an invariant (AC-PAR-002): the in-flight set is drawn
  // from `pollable` alone, so a dependency-blocked issue can never enter it.
  for (const b of blockedByDependencies(store, config)) {
    log(formatBlockedLine(b.issueId, b.waitingOn));
  }
  // Bounded fan-out (AC-PAR-001): at most `cap` issues in flight; excess waits and takes
  // slots in stable queue (id) order, so every queued issue is driven — no starvation.
  // Results keep queue order, and cap 1 reproduces today's sequential drive exactly.
  const drive = opts.driveIssue ?? ((issue: Issue) => driveIssueLive(store, config, issue, harnessRoot, opts, log));
  // The peak is OBSERVED here, at the dispatch seam — the one place every in-flight
  // interval passes through, whatever worker drives the issue — so the recorded fact
  // holds for the real driver and the injected one alike (AC-PAR-003).
  let inFlight = 0;
  let peak = 0;
  const results = await mapPool(queue, cap, async (issue) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      return await drive(issue);
    } finally {
      inFlight -= 1;
    }
  });
  // The turn's concurrency facts persist in the store (never log-only): metrics read
  // the latest record as the turn instruments, null when no turn was ever recorded.
  store.addTurnRecord(
    TurnRecord.parse({
      id: store.nextId('TURN'), cap, issuesDriven: queue.length, peakConcurrency: peak, createdAt: nowISO(),
    }),
  );
  // ③ every live turn ends by capturing failures into the regression registry,
  // re-verifying the bound registry against the target's real graders, and reporting
  // (never enacting) improvement suggestions — ADR-0007 I2.
  improveTick(store, log, { config });
  store.save();
  return results;
}
