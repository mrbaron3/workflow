/**
 * The Eval Curator closes the learning loop: it promotes blocker acceptance criteria
 * (especially ones that have actually failed in a run) into the Eval Task Registry as
 * regression tasks. Over time the registry grows from real failures rather than being
 * hand-written up front — exactly the "grow the eval set from production" practice.
 */

import { EvalTask, type VerificationMethod } from '../domain/schema.js';
import { Store, nowISO } from '../store/store.js';
import type { HarnessConfig, TargetRepoConfig } from '../config.js';

export interface CurateResult {
  created: EvalTask[];
}

/** config.target.graders key per verification method (the config key for unit_test is plural). */
const GRADER_KEY_BY_METHOD: Partial<Record<VerificationMethod, keyof NonNullable<TargetRepoConfig['graders']>>> = {
  unit_test: 'unit_tests',
  typecheck: 'typecheck',
};

/**
 * The grader command config provides for this AC's verification method, as the task's own
 * captured means of execution (EvalTask.graderCommands) — so repointing config.target later
 * cannot orphan the task. A method with no configured command captures nothing (null, the
 * legacy shape): commands are recorded, never fabricated.
 */
function captureGraderCommands(method: VerificationMethod, target?: TargetRepoConfig): Record<string, string> | null {
  const key = GRADER_KEY_BY_METHOD[method];
  const command = key ? target?.graders?.[key] : undefined;
  return command ? { [method]: command } : null;
}

/**
 * `config` (optional, backward compatible) binds each new task to the target repo it was
 * observed failing against (EvalTask.target) — the regression executor only runs tasks
 * bound to the current target, because the registry can mix targets and AC ids collide
 * across issues. Without a config the task stays unbound (target: null) and is skipped
 * by the executor, reported, never guessed.
 */
export function curateEvalTasks(store: Store, config?: HarnessConfig): CurateResult {
  const created: EvalTask[] = [];
  // Which (issue, criterion) pairs have actually failed at least once?
  const failed = new Set<string>();
  for (const run of store.db.evalRuns) {
    for (const f of run.findings) failed.add(`${run.issueId}:${f.criterionId}`);
  }

  for (const issue of store.db.issues) {
    if (store.runsForIssue(issue.id).length === 0) continue;
    for (const ac of issue.contract?.acceptanceCriteria ?? []) {
      if (ac.severity !== 'blocker') continue;
      const id = `EVAL-TASK-${issue.id}-${ac.id}`;
      if (store.db.evalTasks.some((t) => t.id === id)) continue;
      const everFailed = failed.has(`${issue.id}:${ac.id}`);
      created.push(
        store.addEvalTask(
          EvalTask.parse({
            id,
            sourceIssueId: issue.id,
            featureArea: issue.area,
            userGoal: ac.behavior,
            steps: ac.verification.expected.map((e) => `Verify: ${e}`),
            expected: ac.verification.expected,
            graders: [ac.verification.method],
            severity: 'blocker',
            target: config?.target?.repo ?? null,
            graderCommands: captureGraderCommands(ac.verification.method, config?.target),
            createdAt: nowISO(),
            // tag regressions in userGoal so they're visible without a schema change
            ...(everFailed ? { userGoal: `[regression] ${ac.behavior}` } : {}),
          }),
        ),
      );
    }
  }
  return { created };
}
