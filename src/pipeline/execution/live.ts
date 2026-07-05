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

import type { Issue } from '../../domain/schema.js';
import type { HarnessConfig } from '../../config.js';
import { Store, nowISO } from '../../store/store.js';
import { PR } from '../../domain/schema.js';
import { pollable } from './guard.js';
import { runGeneratorSession } from './session.js';
import { groundArtifact } from './grade.js';
import { runPerspectiveSessions, sessionBackedGrader } from './perspective-session.js';
import { runPanel, PERSPECTIVES, type PerspectiveSpec } from '../panel.js';
import { runBoundedRepairLoop, type DriveResult } from './loop.js';
import { openGate, realGhGateRunner, type GhGateRunner } from './gate.js';

export interface LiveOptions {
  /** Which lenses to convene (default: all 7). Reduce it for a cheap smoke. */
  perspectives?: PerspectiveSpec[];
  /** Gate backend runner (github only). Injectable for tests; defaults to the real `gh` runner. */
  gateRunner?: GhGateRunner;
}

/**
 * Drive ONE ai-managed issue through the live bounded repair loop: (generate → ground → panel)*
 * → gate. Each attempt is a real generator session grounded in real tsc/vitest and reviewed by
 * real read-only perspective sessions; on request_changes the cross-perspective findings ride
 * into the next attempt as a repair brief and the worktree is reused so edits accumulate
 * (AC-REPAIR-001). The bound is config.maxRepairs+1; exhaustion or a stuck/timed-out generator
 * escalates to needs-human-review with the session kept alive (ARCH-execution-014/015) — never a
 * silent grade. Only the sessions are non-deterministic; the loop is shared with the mock drive.
 */
export async function driveIssueLive(
  store: Store,
  config: HarnessConfig,
  issue: Issue,
  harnessRoot: string = process.cwd(),
  opts: LiveOptions = {},
  log: (m: string) => void = () => {},
): Promise<DriveResult> {
  const contract = issue.contract;
  if (!contract) throw new Error(`${issue.id} has no contract`);
  if (!config.target) throw new Error('driveIssueLive requires config.target (a real repo)');
  const target = config.target;
  const perspectives = opts.perspectives ?? PERSPECTIVES;
  const issueKey = `${issue.id.toLowerCase()}-s0`;
  const maxAttempts = config.maxRepairs + 1;

  store.setStatus(issue.id, 'ready-for-generation');
  store.setStatus(issue.id, 'generation-in-progress');
  const pr = store.addPR(
    PR.parse({
      id: store.nextId('PR'), issueId: issue.id, branch: `agent/${issueKey}`,
      baseBranch: config.baseBranch, generator: config.generator, attempts: 0, status: 'open',
      createdAt: nowISO(), updatedAt: nowISO(),
    }),
  );

  let approvedWorktree: string | null = null; // the checkout at the gate, for the github projection

  const loop = await runBoundedRepairLoop(store, config, issue.id, pr, async (attempt, repairBrief) => {
    // 1. real generator session — carries the repair brief on attempt > 1 and reuses the worktree
    log(`▶ ${issue.id}: generator session (attempt ${attempt}/${maxAttempts})`);
    const sess = await runGeneratorSession(config, { issue, contract, sampleIndex: 0, attempt, repairBrief }, harnessRoot, log);
    if (sess.outcome !== 'completed') {
      log(`  ⚠ ${issue.id}: generator ${sess.outcome} — escalating, session kept alive`);
      return { stuck: true };
    }
    approvedWorktree = sess.worktree; // the reused worktree; the last completed attempt is the build at the gate

    store.setStatus(issue.id, 'ready-for-evaluation');
    store.setStatus(issue.id, 'evaluation-in-progress');

    // 2. ground the checkout with real graders (real tsc/vitest)
    const artifact = groundArtifact({ contract, target, worktree: sess.worktree, branch: sess.branch, changed: sess.changed });

    // 3. real read-only perspective sessions -> findings.json under the worktree
    log(`  ${issue.id}: evaluator panel (${perspectives.filter((p) => !p.deterministic).length} live lenses)`);
    const panelSessions = await runPerspectiveSessions(config, { worktree: sess.worktree, contract, perspectives, issueKey }, log);

    // 4. panel grades from the findings.json files (missing/broken -> escalate); functionality is deterministic
    const panel = runPanel(
      store, config,
      { issueId: issue.id, prId: pr.id, contract, artifact, sampleIndex: 0, attempt, agent: config.generator, featureArea: issue.area },
      { perspectives, grader: sessionBackedGrader(panelSessions.evalRoot) },
    );
    return { panel };
  }, log);

  // Project an approved build to the gate UI (ADR-0006 G1). No-op for the store backend; for github
  // it pushes the branch + opens the PR the human merges to release. Poll it later with pollGate.
  if (loop.verdict === 'approve' && (config.gate?.backend ?? 'store') === 'github' && approvedWorktree) {
    openGate(store, config, { pr, worktree: approvedWorktree, title: `${issue.id}: ${issue.title}` }, opts.gateRunner ?? realGhGateRunner(), log);
  }

  log(`  = ${issue.id}: ${loop.verdict}${loop.gateFailed ? ' (gate failed — no lenses convened)' : ''} → ${loop.status} [${loop.attempts} attempt(s)]`);
  return { issueId: issue.id, prId: pr.id, ...loop };
}

/** One live turn over the ai-managed queue (the watch daemon's live run-once). */
export async function runLoopLive(
  store: Store, config: HarnessConfig, harnessRoot: string = process.cwd(),
  opts: LiveOptions = {}, log: (m: string) => void = () => {},
): Promise<DriveResult[]> {
  const queue = pollable(store, config);
  log(`queue: ${queue.length} ai-managed issue(s) [generator=${config.generator}]`);
  const results: DriveResult[] = [];
  for (const issue of queue) results.push(await driveIssueLive(store, config, issue, harnessRoot, opts, log));
  store.save();
  return results;
}
