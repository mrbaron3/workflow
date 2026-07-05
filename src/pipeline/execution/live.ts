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
import type { HarnessConfig } from '../../config.js';
import { Store, nowISO } from '../../store/store.js';
import { PR } from '../../domain/schema.js';
import { pollable } from './guard.js';
import { runGeneratorSession } from './session.js';
import { groundArtifact } from './grade.js';
import { runPerspectiveSessions, sessionBackedGrader } from './perspective-session.js';
import { runPanel, PERSPECTIVES, type PerspectiveSpec } from '../panel.js';
import { applyPanelVerdict, type DriveResult } from './loop.js';

export interface LiveOptions {
  /** Which lenses to convene (default: all 7). Reduce it for a cheap smoke. */
  perspectives?: PerspectiveSpec[];
}

/**
 * Drive ONE ai-managed issue through one live attempt: generate → ground → panel → gate.
 * Single attempt for now — live repair needs runGeneratorSession to accept a brief (follow-up);
 * the sandbox runs with maxRepairs=0. A stuck/timed-out generator escalates to needs-human-review
 * with the session kept alive (ARCH-execution-014/015), never a silent grade.
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
  const perspectives = opts.perspectives ?? PERSPECTIVES;

  store.setStatus(issue.id, 'ready-for-generation');
  store.setStatus(issue.id, 'generation-in-progress');
  const pr = store.addPR(
    PR.parse({
      id: store.nextId('PR'), issueId: issue.id, branch: `agent/${issue.id.toLowerCase()}-s0`,
      baseBranch: config.baseBranch, generator: config.generator, attempts: 1, status: 'open',
      createdAt: nowISO(), updatedAt: nowISO(),
    }),
  );

  // 1. real generator session -> worktree with real edits
  log(`▶ ${issue.id}: generator session`);
  const sess = await runGeneratorSession(config, { issue, contract, sampleIndex: 0, attempt: 1 }, harnessRoot, log);
  if (sess.outcome !== 'completed') {
    pr.status = 'changes-requested';
    store.setStatus(issue.id, 'needs-human-review'); // liveness surfacing — kept alive
    return { issueId: issue.id, prId: pr.id, verdict: 'needs_human', status: store.getIssue(issue.id)!.status, gateFailed: false, escalated: true, attempts: 1, exhausted: false };
  }

  store.setStatus(issue.id, 'ready-for-evaluation');
  store.setStatus(issue.id, 'evaluation-in-progress');

  // 2. ground the checkout with real graders
  const artifact = groundArtifact({ contract, target: config.target, worktree: sess.worktree, branch: sess.branch, changed: sess.changed });

  // 3. real read-only perspective sessions -> findings.json under the worktree
  log(`  ${issue.id}: evaluator panel (${perspectives.filter((p) => !p.deterministic).length} live lenses)`);
  const panelSessions = await runPerspectiveSessions(config, { worktree: sess.worktree, contract, perspectives, issueKey: `${issue.id.toLowerCase()}-s0` }, log);

  // 4. panel grades from the findings.json files (missing/broken -> escalate); functionality is deterministic
  const panel = runPanel(
    store, config,
    { issueId: issue.id, prId: pr.id, contract, artifact, sampleIndex: 0, attempt: 1, agent: config.generator, featureArea: issue.area },
    { perspectives, grader: sessionBackedGrader(panelSessions.evalRoot) },
  );

  // 5. route through the gate (approve -> build-approved -> needs-human-review; never auto-release)
  if (!panel.escalated) applyPanelVerdict(store, issue.id, panel.verdict);
  pr.status = panel.verdict === 'approve' ? 'approved' : 'changes-requested';
  pr.updatedAt = nowISO();

  log(`  = ${issue.id}: panel ${panel.verdict}${panel.gateFailed ? ' (gate failed — no lenses convened)' : ''} → ${store.getIssue(issue.id)!.status}`);
  return { issueId: issue.id, prId: pr.id, verdict: panel.verdict, status: store.getIssue(issue.id)!.status, gateFailed: panel.gateFailed, escalated: panel.escalated, attempts: 1, exhausted: false };
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
