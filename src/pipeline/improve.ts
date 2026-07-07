/**
 * The ③ tail of a live turn (ADR-0007 I2): after the queue is driven, capture what failed,
 * re-verify what was captured, and report what the Analyst would improve.
 *
 * Curator runs unconditionally — it is idempotent, deterministic and costless, and the
 * steering star ("never repeat the same failure twice") must not depend on a human
 * remembering to run `agentops curate`. When a config is supplied (the live turn has one),
 * the curator binds new tasks to the current target AND the regression executor re-runs
 * the bound registry against the target's real graders — the star's second half. The
 * Analyst stays REPORT-ONLY: creating backlog issues (`analyze --create`) and adopting
 * them (`agentops adopt`) are human decisions, because autonomous WHAT is an explicit
 * non-goal (NORTH_STAR).
 */

import type { Store } from '../store/store.js';
import type { EvalTask } from '../domain/schema.js';
import type { HarnessConfig } from '../config.js';
import { curateEvalTasks } from './curator.js';
import { analyzeHarness, type Suggestion } from './analyst.js';
import { runRegressionTasks, type RegressResult, type RegressReportRunner } from './regression.js';
import { computeMetrics } from '../metrics/metrics.js';

export interface ImproveTickOptions {
  /** The live turn's config: binds curated tasks to the target and enables the executor. */
  config?: HarnessConfig;
  /** Injectable vitest-report producer for the executor (tests; defaults to the real run). */
  regressReport?: RegressReportRunner;
}

export interface ImproveTickResult {
  curated: EvalTask[];
  suggestions: Suggestion[];
  /** Regression execution summary; null when no config was supplied (legacy call shape). */
  regression: RegressResult | null;
}

export function improveTick(store: Store, log: (m: string) => void = () => {}, opts: ImproveTickOptions = {}): ImproveTickResult {
  const { created, enriched } = curateEvalTasks(store, opts.config);
  if (created.length) {
    log(`③ curated ${created.length} regression eval task(s) → registry ${store.db.evalTasks.length}`);
  }
  if (enriched.length) {
    log(`③ enriched ${enriched.length} legacy eval task(s) with grader commands`);
  }

  let regression: RegressResult | null = null;
  if (opts.config?.target) {
    regression = runRegressionTasks(store, opts.config, { report: opts.regressReport });
    const fails = regression.results.filter((r) => r.result === 'fail');
    const unverified = regression.results.filter((r) => r.result === 'unverified');
    if (regression.results.length || regression.skipped.length) {
      log(`③ regression: ${regression.results.length} executed (${fails.length} FAIL, ${unverified.length} unverified), ${regression.skipped.length} skipped`);
    }
    for (const f of fails) log(`  ✗ ${f.taskId}: ${f.failedNames.join('; ')}`);
    for (const u of unverified) log(`  ? ${u.taskId}: no assertion carries its AC id — not verifiable, not a pass`);
  }

  const suggestions = analyzeHarness(store, computeMetrics(store));
  for (const s of suggestions) log(`③ analyst: [${s.type}] ${s.title}`);
  if (suggestions.length) {
    log(`  (to act on these: agentops analyze --create, then agentops adopt <ISSUE-ID> --contract <yaml>)`);
  }
  return { curated: created, suggestions, regression };
}
