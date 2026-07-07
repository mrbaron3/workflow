/**
 * The ③ tail of a live turn (ADR-0007 I2): after the queue is driven, capture what failed
 * and report what the Analyst would improve.
 *
 * Curator runs unconditionally — it is idempotent, deterministic and costless, and the
 * steering star ("never repeat the same failure twice") must not depend on a human
 * remembering to run `agentops curate`. The Analyst runs REPORT-ONLY: creating backlog
 * issues (`analyze --create`) and adopting them (`agentops adopt`) stay human decisions,
 * because autonomous WHAT is an explicit non-goal (NORTH_STAR).
 */

import type { Store } from '../store/store.js';
import type { EvalTask } from '../domain/schema.js';
import { curateEvalTasks } from './curator.js';
import { analyzeHarness, type Suggestion } from './analyst.js';
import { computeMetrics } from '../metrics/metrics.js';

export interface ImproveTickResult {
  curated: EvalTask[];
  suggestions: Suggestion[];
}

export function improveTick(store: Store, log: (m: string) => void = () => {}): ImproveTickResult {
  const { created } = curateEvalTasks(store);
  if (created.length) {
    log(`③ curated ${created.length} regression eval task(s) → registry ${store.db.evalTasks.length}`);
  }
  const suggestions = analyzeHarness(store, computeMetrics(store));
  for (const s of suggestions) log(`③ analyst: [${s.type}] ${s.title}`);
  if (suggestions.length) {
    log(`  (to act on these: agentops analyze --create, then agentops adopt <ISSUE-ID> --contract <yaml>)`);
  }
  return { curated: created, suggestions };
}
