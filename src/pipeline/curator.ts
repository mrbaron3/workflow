/**
 * The Eval Curator closes the learning loop: it promotes blocker acceptance criteria
 * (especially ones that have actually failed in a run) into the Eval Task Registry as
 * regression tasks. Over time the registry grows from real failures rather than being
 * hand-written up front — exactly the "grow the eval set from production" practice.
 */

import { EvalTask } from '../domain/schema.js';
import { Store, nowISO } from '../store/store.js';

export interface CurateResult {
  created: EvalTask[];
}

export function curateEvalTasks(store: Store): CurateResult {
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
