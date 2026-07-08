/**
 * The regression EXECUTOR (ADR-0007 帰結の次スライス) — the second half of the steering
 * star: the Curator captures failures into the Eval Task Registry; this re-verifies them
 * against their target's REAL graders, durably (RegressionRun, ADR-0001).
 *
 * Semantics (AC-REGMT-001..004): each task runs against its OWN bound target with the
 * grader command it captured at curation time — repointing config.target at another repo
 * does not orphan it. All tasks bound to one target share ONE grader run (they judge the
 * same tree; runs never exceed the number of targets), then each task's AC id is matched
 * against assertion names — the same convention groundArtifact's `satisfied` uses, so a
 * task passes exactly when the tests tagged with its AC id all pass. A command-less
 * legacy task falls back to config.target.graders when bound to the current target.
 *
 * Discipline (never-silent, ARCH-execution-015 の精神):
 *   - a task missing an execution precondition (unbound legacy null, bound repo absent
 *     from disk, no runnable command) is skipped AND reported with the reason naming
 *     WHICH precondition is missing — never fabricated as pass/fail;
 *   - an AC id matching zero assertions is 'unverified' — recorded, never a pass.
 * The judgement itself is deterministic; the only real-world seam (running vitest) is
 * injectable for tests (ADR-0004's pluggable-backend pattern).
 */

import fs from 'node:fs';
import path from 'node:path';
import { RegressionRun, type EvalTask } from '../domain/schema.js';
import { isRetired, parseTaskId } from '../domain/eval-task.js';
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
  /** Resolve each task's bound target repo against this root (defaults to the store's root). */
  harnessRoot?: string;
}

/**
 * The (issue, AC) a task verifies, from the curator's id convention EVAL-TASK-<issue>-<ac>
 * (single shared encoding: domain/eval-task.ts). `sourceIssueId` is authoritative when
 * present; without it the id itself still IS the convention, so a hand-seeded/legacy row
 * that follows it stays verifiable rather than reading as eternally 'unverified'.
 */
function taskCriterion(task: EvalTask): { issueId: string; acId: string } | null {
  return parseTaskId(task.id, task.sourceIssueId);
}

export function runRegressionTasks(store: Store, config: HarnessConfig, opts: RegressOptions = {}): RegressResult {
  const results: RegressionRun[] = [];
  const skipped: RegressResult['skipped'] = [];
  const targetRepo = config.target?.repo ?? null;
  const configUnitTests = config.target?.graders?.unit_tests;
  const root = opts.harnessRoot ?? store.root;

  // Resolve each task's execution means: its captured command wins (config.target may have
  // been repointed since curation); a command-less legacy task falls back to config's
  // command only when bound to that same target. Missing preconditions skip WITH the reason.
  const runnable: { task: EvalTask; command: string }[] = [];
  for (const task of store.db.evalTasks) {
    // Retired tasks (FEAT-005) come first: retirement is the definitive judgment, so it is
    // reported over any missing precondition. Never executed, never a RegressionRun — but
    // never silent either: the human's reason travels with the report.
    if (isRetired(task)) {
      skipped.push({ taskId: task.id, reason: `retired (${task.retiredReason ?? 'no reason recorded'})` });
      continue;
    }
    if (!task.graders.includes('unit_test')) {
      skipped.push({ taskId: task.id, reason: `grader ${task.graders.join('/') || '(none)'} not executable (v0 runs unit_test only)` });
      continue;
    }
    if (task.target === null) {
      skipped.push({ taskId: task.id, reason: 'unbound (legacy task with no target — re-curate under a config to bind)' });
      continue;
    }
    const command = task.graderCommands?.['unit_test'] ?? (task.target === targetRepo ? configUnitTests : undefined);
    if (!command) {
      skipped.push({
        taskId: task.id,
        reason: task.target === targetRepo
          ? 'no grader command: config.target.graders.unit_tests is not configured'
          : `no grader command: none captured at curation, and bound target ${task.target} is not the current ${targetRepo ?? '(none)'} — re-curate to capture`,
      });
      continue;
    }
    if (!fs.existsSync(path.resolve(root, task.target))) {
      skipped.push({ taskId: task.id, reason: `bound target repo ${task.target} does not exist on disk under ${root}` });
      continue;
    }
    runnable.push({ task, command });
  }

  // ONE grader run per bound target — all its tasks judge the same tree, so they share the
  // report and runs never exceed the number of targets. The first task's resolved command
  // speaks for the whole target (same-curation siblings captured the same command).
  const byTarget = new Map<string, { command: string; tasks: EvalTask[] }>();
  for (const { task, command } of runnable) {
    const group = byTarget.get(task.target!) ?? { command, tasks: [] };
    group.tasks.push(task);
    byTarget.set(task.target!, group);
  }

  const runReport = opts.report ?? runVitest;
  for (const [target, { command, tasks }] of byTarget) {
    const report = runReport(command, path.resolve(root, target));
    for (const task of tasks) {
      const criterion = taskCriterion(task);
      // Issue-scoped matching (assertionsForCriterion): the grounded false positive was another
      // issue's identically-named red AC bleeding into this task via bare substring matching.
      const matched = criterion ? assertionsForCriterion(report.assertions, criterion.acId, criterion.issueId) : [];
      const failed = matched.filter((a) => !a.passed);
      const result = matched.length === 0 ? 'unverified' : failed.length === 0 ? 'pass' : 'fail';
      results.push(
        store.addRegressionRun(
          RegressionRun.parse({
            id: store.nextId('REGRUN'),
            taskId: task.id,
            target,
            result,
            matchedAssertions: matched.length,
            failedNames: failed.map((a) => a.name),
            createdAt: nowISO(),
          }),
        ),
      );
    }
  }
  return { results, skipped };
}
