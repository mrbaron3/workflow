/**
 * The regression EXECUTOR (ADR-0007 帰結の次スライス) — the second half of the steering
 * star: the Curator captures failures into the Eval Task Registry; this re-verifies them
 * against their target's REAL graders, durably (RegressionRun, ADR-0001).
 *
 * Semantics (AC-REGMT-001..004): each task runs against its OWN bound target with the
 * grader command it captured at curation time — repointing config.target at another repo
 * does not orphan it. All tasks bound to one target share ONE grader run (they judge the
 * same tree), then each unit-test task's AC id is matched against assertion names. Other
 * verification methods execute their captured command per criterion with AGENTOPS_AC_ID /
 * EXPECTED_JSON, matching groundArtifact's command contract. A command-less legacy task
 * falls back to config.target.graders when bound to the current target.
 *
 * Discipline (never-silent, ARCH-execution-015 の精神):
 *   - a task missing an execution precondition (unbound legacy null, bound repo absent
 *     from disk, no runnable command) is skipped AND reported with the reason naming
 *     WHICH precondition is missing — never fabricated as pass/fail;
 *   - an AC id matching zero assertions is 'unverified' — recorded, never a pass.
 * The judgement itself is deterministic; real command/report execution is injectable for
 * tests (ADR-0004's pluggable-backend pattern).
 */

import fs from 'node:fs';
import path from 'node:path';
import { RegressionRun, type EvalTask, type VerificationMethod } from '../domain/schema.js';
import { isRetired, parseTaskId } from '../domain/eval-task.js';
import { configuredGraderCommand, type HarnessConfig } from '../config.js';
import { Store, nowISO } from '../store/store.js';
import {
  assertionsForCriterion,
  runGraderCommand,
  runVitest,
  type CmdResult,
  type VitestReport,
} from './execution/grade.js';

/** Structured unit-test seam; other verification methods use RegressCommandRunner. */
export type RegressReportRunner = (unitTestsCommand: string, cwd: string) => VitestReport;
export type RegressCommandRunner = (
  command: string,
  cwd: string,
  env: Record<string, string>,
) => CmdResult;

export interface RegressResult {
  results: RegressionRun[];
  skipped: { taskId: string; reason: string }[];
}

export interface RegressOptions {
  /** Injectable report producer; defaults to really running the grader (runVitest). */
  report?: RegressReportRunner;
  /** Injectable non-unit verification command runner. */
  command?: RegressCommandRunner;
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
  const root = opts.harnessRoot ?? store.root;

  // Resolve each task's execution means: its captured command wins (config.target may have
  // been repointed since curation); a command-less legacy task falls back to config's
  // command only when bound to that same target. Missing preconditions skip WITH the reason.
  const runnable: { task: EvalTask; method: VerificationMethod; command: string }[] = [];
  for (const task of store.db.evalTasks) {
    // Retired tasks (FEAT-005) come first: retirement is the definitive judgment, so it is
    // reported over any missing precondition. Never executed, never a RegressionRun — but
    // never silent either: the human's reason travels with the report.
    if (isRetired(task)) {
      skipped.push({ taskId: task.id, reason: `retired (${task.retiredReason ?? 'no reason recorded'})` });
      continue;
    }
    if (task.graders.length !== 1) {
      skipped.push({ taskId: task.id, reason: `expected exactly one grader method, got ${task.graders.join('/') || '(none)'}` });
      continue;
    }
    const method = task.graders[0]!;
    if (method === 'scope_check') {
      skipped.push({ taskId: task.id, reason: 'scope_check is intrinsic to a build diff and cannot be replayed without captured changed files' });
      continue;
    }
    if (task.target === null) {
      skipped.push({ taskId: task.id, reason: 'unbound (legacy task with no target — re-curate under a config to bind)' });
      continue;
    }
    const command = task.graderCommands?.[method]
      ?? (task.target === targetRepo ? configuredGraderCommand(config.target, method) : undefined);
    if (!command) {
      skipped.push({
        taskId: task.id,
        reason: task.target === targetRepo
          ? `no grader command: config.target has no command for ${method}`
          : `no grader command: none captured at curation, and bound target ${task.target} is not the current ${targetRepo ?? '(none)'} — re-curate to capture`,
      });
      continue;
    }
    if (!fs.existsSync(path.resolve(root, task.target))) {
      skipped.push({ taskId: task.id, reason: `bound target repo ${task.target} does not exist on disk under ${root}` });
      continue;
    }
    runnable.push({ task, method, command });
  }

  // Unit tests retain one shared structured report per target+command. Other verification
  // methods run per criterion because the command receives AGENTOPS_AC_ID/EXPECTED_JSON.
  const unitGroups = new Map<string, { target: string; command: string; tasks: EvalTask[] }>();
  const commandTasks: typeof runnable = [];
  for (const entry of runnable) {
    const { task, method, command } = entry;
    if (method !== 'unit_test') {
      commandTasks.push(entry);
      continue;
    }
    const key = JSON.stringify([task.target, command]);
    const group = unitGroups.get(key) ?? { target: task.target!, command, tasks: [] };
    group.tasks.push(task);
    unitGroups.set(key, group);
  }

  const runReport = opts.report ?? runVitest;
  for (const { target, command, tasks } of unitGroups.values()) {
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

  const runCommand = opts.command ?? runGraderCommand;
  for (const { task, method, command } of commandTasks) {
    const target = task.target!;
    const criterion = taskCriterion(task);
    if (!criterion) {
      results.push(
        store.addRegressionRun(
          RegressionRun.parse({
            id: store.nextId('REGRUN'), taskId: task.id, target,
            result: 'unverified', matchedAssertions: 0, failedNames: [], createdAt: nowISO(),
          }),
        ),
      );
      continue;
    }
    const result = runCommand(command, path.resolve(root, target), {
      AGENTOPS_AC_ID: criterion.acId,
      AGENTOPS_ISSUE_ID: criterion.issueId,
      AGENTOPS_VERIFICATION_METHOD: method,
      AGENTOPS_EXPECTED_JSON: JSON.stringify(task.expected),
    });
    const output = result.output.trim().slice(-1000);
    results.push(
      store.addRegressionRun(
        RegressionRun.parse({
          id: store.nextId('REGRUN'),
          taskId: task.id,
          target,
          result: result.ok ? 'pass' : 'fail',
          matchedAssertions: 1,
          failedNames: result.ok ? [] : [output || `${method} command exited non-zero`],
          createdAt: nowISO(),
        }),
      ),
    );
  }
  return { results, skipped };
}
