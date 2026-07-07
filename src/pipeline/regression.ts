/**
 * The regression EXECUTOR (ADR-0007 帰結の次スライス) — the second half of the steering
 * star: the Curator captures failures into the Eval Task Registry; this re-verifies them
 * against the target's REAL graders, durably (RegressionRun, ADR-0001).
 *
 * v0 semantics: run the current target's unit_tests grader ONCE, then match each bound
 * task's AC id against assertion names — the same convention groundArtifact's `satisfied`
 * uses, so a task passes exactly when the tests tagged with its AC id all pass.
 *
 * Discipline (never-silent, ARCH-execution-015 の精神):
 *   - a task bound to ANOTHER repo (or unbound legacy null) is skipped AND reported;
 *   - an AC id matching zero assertions is 'unverified' — recorded, never a pass;
 *   - no unit_tests grader configured → everything skipped and reported, nothing fabricated.
 * The judgement itself is deterministic; the only real-world seam (running vitest) is
 * injectable for tests (ADR-0004's pluggable-backend pattern).
 */

import path from 'node:path';
import { RegressionRun, type EvalTask } from '../domain/schema.js';
import type { HarnessConfig } from '../config.js';
import { Store, nowISO } from '../store/store.js';
import { assertionsForCriterion, runVitest, type VitestReport } from './execution/grade.js';

/** The one non-deterministic seam: produce a vitest report for the grader command. */
export type RegressReportRunner = (unitTestsCommand: string, cwd: string) => VitestReport;

export interface RegressResult {
  results: RegressionRun[];
  skipped: { taskId: string; reason: string }[];
}

export interface RegressOptions {
  /** Injectable report producer; defaults to really running the grader (runVitest). */
  report?: RegressReportRunner;
  /** Resolve config.target.repo against this root (defaults to the store's root). */
  harnessRoot?: string;
}

/** The AC id a task verifies, from the curator's id convention EVAL-TASK-<issue>-<ac>. */
function taskAcId(task: EvalTask): string | null {
  if (!task.sourceIssueId) return null;
  const prefix = `EVAL-TASK-${task.sourceIssueId}-`;
  return task.id.startsWith(prefix) ? task.id.slice(prefix.length) : null;
}

export function runRegressionTasks(store: Store, config: HarnessConfig, opts: RegressOptions = {}): RegressResult {
  const results: RegressionRun[] = [];
  const skipped: RegressResult['skipped'] = [];
  const targetRepo = config.target?.repo ?? null;
  const unitTests = config.target?.graders?.unit_tests;

  const runnable: EvalTask[] = [];
  for (const task of store.db.evalTasks) {
    if (!task.graders.includes('unit_test')) {
      skipped.push({ taskId: task.id, reason: `grader ${task.graders.join('/') || '(none)'} not executable (v0 runs unit_test only)` });
    } else if (task.target === null) {
      skipped.push({ taskId: task.id, reason: 'unbound (legacy task with no target — re-curate under a config to bind)' });
    } else if (targetRepo === null || task.target !== targetRepo) {
      skipped.push({ taskId: task.id, reason: `bound to ${task.target}, current target is ${targetRepo ?? '(none)'}` });
    } else if (!unitTests) {
      skipped.push({ taskId: task.id, reason: 'config.target.graders.unit_tests is not configured' });
    } else {
      runnable.push(task);
    }
  }
  if (runnable.length === 0) return { results, skipped };

  // ONE grader run serves every runnable task — cheap, and all tasks judge the same tree.
  const root = opts.harnessRoot ?? store.root;
  const cwd = path.resolve(root, targetRepo!);
  const report = (opts.report ?? runVitest)(unitTests!, cwd);

  for (const task of runnable) {
    const acId = taskAcId(task);
    // Issue-scoped matching (assertionsForCriterion): the grounded false positive was another
    // issue's identically-named red AC bleeding into this task via bare substring matching.
    const matched = acId ? assertionsForCriterion(report.assertions, acId, task.sourceIssueId) : [];
    const failed = matched.filter((a) => !a.passed);
    const result = matched.length === 0 ? 'unverified' : failed.length === 0 ? 'pass' : 'fail';
    results.push(
      store.addRegressionRun(
        RegressionRun.parse({
          id: store.nextId('REGRUN'),
          taskId: task.id,
          target: task.target!,
          result,
          matchedAssertions: matched.length,
          failedNames: failed.map((a) => a.name),
          createdAt: nowISO(),
        }),
      ),
    );
  }
  return { results, skipped };
}
