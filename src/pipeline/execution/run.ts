/**
 * Minimal execution run (the first end-to-end slice of ARCH-execution-001).
 *
 * Drains the ai-managed queue once: for each pollable issue, run ONE generator session in a
 * tmux worktree, ground it with real graders, and record an EvalRun via evaluation's grader.
 * This is deliberately the thin path — single sample, no repair loop, single-perspective grade,
 * no human-review gate yet. The evaluator panel (7 perspectives), the repair loop, and the
 * review gate are the next slices; the orchestration seam and evidence trail are already here.
 */

import { PR, type Issue } from '../../domain/schema.js';
import type { HarnessConfig } from '../../config.js';
import { Store, nowISO } from '../../store/store.js';
import { evaluate } from '../evaluate.js';
import { pollable } from './guard.js';
import { runGeneratorSession } from './session.js';
import { groundArtifact } from './grade.js';

export interface ExecOnceResult {
  issueId: string;
  verdict: string;
  sentinelSeen: boolean;
  overall: number;
  evalId: string;
}

export async function runExecutionOnce(
  store: Store,
  config: HarnessConfig,
  harnessRoot: string = process.cwd(),
  log: (m: string) => void = () => {},
): Promise<ExecOnceResult[]> {
  if (!config.target) throw new Error('execution run needs config.target (a real repo).');
  const queue = pollable(store, config);
  log(`queue: ${queue.length} ai-managed issue(s) [agent=${config.generator}]`);

  const results: ExecOnceResult[] = [];
  for (const issue of queue) {
    results.push(await runOne(store, config, harnessRoot, issue, log));
  }
  store.save();
  return results;
}

async function runOne(
  store: Store,
  config: HarnessConfig,
  harnessRoot: string,
  issue: Issue,
  log: (m: string) => void,
): Promise<ExecOnceResult> {
  const contract = issue.contract;
  if (!contract) throw new Error(`${issue.id} has no contract.`);
  log(`▶ ${issue.id} ${issue.title}`);

  store.setStatus(issue.id, 'ready-for-generation');
  store.setStatus(issue.id, 'generation-in-progress');

  const pr = store.addPR(
    PR.parse({
      id: store.nextId('PR'),
      issueId: issue.id,
      branch: `agent/${issue.id.toLowerCase()}-s0`,
      baseBranch: config.baseBranch,
      generator: config.generator,
      attempts: 1,
      status: 'open',
      createdAt: nowISO(),
      updatedAt: nowISO(),
    }),
  );

  const sess = await runGeneratorSession(config, { issue, contract, sampleIndex: 0, attempt: 1 }, harnessRoot, log);

  store.setStatus(issue.id, 'ready-for-evaluation');
  store.setStatus(issue.id, 'evaluation-in-progress');

  const artifact = groundArtifact({
    contract,
    target: config.target!,
    worktree: sess.worktree,
    branch: sess.branch,
    changed: sess.changed,
  });
  const run = evaluate(store, config, { issue, pr, artifact, sampleIndex: 0, attempt: 1 });

  // Mirror the coordinator's terminal walk; the human-review gate (Q3) is a later slice.
  if (run.verdict === 'approve') {
    pr.status = 'approved';
    store.setStatus(issue.id, 'approved');
    store.setStatus(issue.id, 'ready-to-merge');
    store.setStatus(issue.id, 'released');
  } else {
    pr.status = 'changes-requested';
    store.setStatus(issue.id, 'changes-requested');
    store.setStatus(issue.id, 'needs-human-review');
  }
  pr.updatedAt = nowISO();

  log(
    `  = ${issue.id}: ${run.verdict} (overall ${run.overall.toFixed(2)}, ` +
      `${sess.sentinelSeen ? 'sentinel ✓' : 'no sentinel'}, ${sess.changed.length} files changed)`,
  );
  return { issueId: issue.id, verdict: run.verdict, sentinelSeen: sess.sentinelSeen, overall: run.overall, evalId: run.id };
}
