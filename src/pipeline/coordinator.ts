/**
 * The Coordinator drives the state machine. For each issue it runs N independent
 * best-of-N samples; each sample is a Generator -> Evaluator -> (Repair -> Generator)
 * loop bounded by config.maxRepairs. Running every sample to completion (rather than
 * stopping at the first pass) is deliberate: it's what gives the Eval DB enough data
 * to compute pass@k AND pass^k for the same issue.
 *
 * The issue advances through the documented macro-states so its history reads like a
 * real ticket; the per-sample/per-attempt detail lives in PRs and EvalRuns.
 */

import {
  PR,
  approvePR,
  bindApprovalRevisionToPR,
  requireMutablePR,
  transitionPR,
  updatePR,
  type Issue,
} from '../domain/schema.js';
import type { Verdict } from '../domain/schema.js';
import type { HarnessConfig } from '../config.js';
import { Store, nowISO } from '../store/store.js';
import type { AgentRunner } from './../agents/runner.js';
import { makeRunner } from './../agents/runner.js';
import { evaluate } from './evaluate.js';
import { unreleasedDependencies, formatBlockedLine } from './execution/guard.js';
import { buildRepairBrief } from './repair.js';
import type { RepairBrief } from '../domain/artifact.js';

export interface SampleResult {
  sampleIndex: number;
  prId: string;
  approved: boolean;
  attempts: number;
  finalVerdict: Verdict;
}

export interface RunIssueResult {
  issueId: string;
  title: string;
  approved: boolean;
  samples: SampleResult[];
}

export async function runIssue(
  store: Store,
  config: HarnessConfig,
  runner: AgentRunner,
  issue: Issue,
  log: (msg: string) => void = () => {},
): Promise<RunIssueResult> {
  const contract = issue.contract;
  if (!contract) throw new Error(`Issue ${issue.id} has no contract; run \`plan\` first.`);

  // Macro-state walk (markers for the human-readable ticket history).
  store.setStatus(issue.id, 'ready-for-generation');
  store.setStatus(issue.id, 'generation-in-progress');
  store.setStatus(issue.id, 'ready-for-evaluation');
  store.setStatus(issue.id, 'evaluation-in-progress');

  const samples: SampleResult[] = [];
  let approvedAny = false;

  for (let s = 0; s < config.samples; s++) {
    const createdPr = store.addPR(
      PR.parse({
        id: store.nextId('PR'),
        issueId: issue.id,
        branch: `agent/${issue.id.toLowerCase()}-s${s}`,
        baseBranch: config.baseBranch,
        generator: runner.agent,
        attempts: 0,
        status: 'open',
        createdAt: nowISO(),
        updatedAt: nowISO(),
      }),
    );
    let pr = store.getPR(createdPr.id)!;

    let repairBrief: RepairBrief | null = null;
    let approved = false;
    let attempts = 0;
    let finalVerdict: Verdict = 'request_changes';

    for (let attempt = 1; attempt <= config.maxRepairs + 1; attempt++) {
      attempts = attempt;
      pr = store.replacePR(updatePR(requireMutablePR(pr), { attempts: attempt }));
      const artifact = await runner.generate({
        issue,
        contract,
        sampleIndex: s,
        attempt,
        repairBrief,
      });
      const run = evaluate(store, config, { issue, pr, artifact, sampleIndex: s, attempt });
      finalVerdict = run.verdict;
      const tag = `${issue.id} s${s} a${attempt}`;
      if (run.verdict === 'approve') {
        approved = true;
        const currentRevision = pr.headSha
          ? store.revisionForHead(pr.id, pr.headSha)
          : undefined;
        pr = currentRevision
          && (currentRevision.status === 'reviewing' || currentRevision.status === 'approved')
          ? store.replacePR(approvePR(pr, bindApprovalRevisionToPR(pr, currentRevision)))
          : store.replacePR(transitionPR(pr, { status: 'open' }));
        log(`  ✓ ${tag}: approved (overall ${run.overall.toFixed(2)})`);
        break;
      }
      pr = store.replacePR(transitionPR(pr, { status: 'changes-requested' }));
      repairBrief = buildRepairBrief(run);
      const blockers = run.findings.filter((f) => f.severity === 'blocker').length;
      log(`  ✗ ${tag}: request_changes (${blockers} blocker(s)) → repair`);
    }

    pr = store.replacePR(updatePR(requireMutablePR(pr), {}));
    samples.push({ sampleIndex: s, prId: pr.id, approved, attempts, finalVerdict });
    if (approved) approvedAny = true;
  }

  // Release manager: merge the first approved candidate, advance the issue.
  if (approvedAny) {
    store.setStatus(issue.id, 'approved');
    store.setStatus(issue.id, 'ready-to-merge');
    store.setStatus(issue.id, 'released');
  } else {
    store.setStatus(issue.id, 'changes-requested');
    store.setStatus(issue.id, 'needs-human-review');
  }
  updateEpicProgress(store, issue.epicId);

  return { issueId: issue.id, title: issue.title, approved: approvedAny, samples };
}

/**
 * Run every issue that has a drafted contract and hasn't been run yet, respecting the
 * spec's issue DAG (AC-DAG-003): an issue is dispatched only after every dependsOnIssues
 * predecessor is `released`, and eligibility is RE-EVALUATED after each issue completes —
 * so a dependent whose predecessor was released by this very call is picked up in the
 * same call (no call-start snapshot). Deps-empty issues keep the previous behaviour
 * exactly (insertion order). Issues still blocked when nothing more can run (a
 * predecessor never released) are logged, never silently dropped. `runner` is an
 * additive injection seam (runIssue already had one; runAll only lacked the
 * pass-through); it defaults to the config-selected backend.
 */
export async function runAll(
  store: Store,
  config: HarnessConfig,
  log: (msg: string) => void = () => {},
  runner?: AgentRunner,
): Promise<RunIssueResult[]> {
  const r = runner ?? makeRunner(config);
  const results: RunIssueResult[] = [];
  const attempted = new Set<string>(); // guards the loop even if an issue's status never moves
  const pending = () => store.db.issues.filter((i) => i.status === 'contract-drafted' && !attempted.has(i.id));
  for (;;) {
    const issue = pending().find((i) => unreleasedDependencies(store, i).length === 0);
    if (!issue) break;
    attempted.add(issue.id);
    log(`▶ ${issue.id} ${issue.title} [${config.generator}, ${config.samples} samples]`);
    results.push(await runIssue(store, config, r, issue, log));
  }
  for (const issue of pending()) {
    log(formatBlockedLine(issue.id, unreleasedDependencies(store, issue)));
  }
  return results;
}

function updateEpicProgress(store: Store, epicId: string | null): void {
  if (!epicId) return;
  const epic = store.getEpic(epicId);
  if (!epic) return;
  const issues = epic.issueIds.map((id) => store.getIssue(id)).filter((i): i is Issue => !!i);
  if (issues.length === 0) return;
  const released = issues.filter((i) => i.status === 'released').length;
  epic.status = released === issues.length ? 'done' : released > 0 ? 'in-progress' : 'planned';
}
