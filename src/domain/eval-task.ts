/**
 * Eval Task Registry vocabulary — the single home for the two conventions every consumer
 * shares (ISSUE-0012 gate pins). Before this module the active-task predicate was spelled
 * ad hoc at four call sites and the EVAL-TASK-<issue>-<ac> id convention was encoded at
 * four more, with the executor's fallback imposing a stricter issue-id shape than the
 * writer — exactly the drift a shared deterministic library exists to prevent.
 *
 *   - "retired" (FEAT-005): excluded from execution and the executed/unverified
 *     accounting, never from capture history. A retirement is a state, not an erasure.
 *   - the task id convention: the curator writes it, the capture rate and the regression
 *     executor read it back.
 */

import type { EvalTask } from './schema.js';

/** The FEAT-005 retirement predicate — the one place its encoding lives. */
export function isRetired(task: EvalTask): boolean {
  return task.retiredAt !== null;
}

/** The registry minus retired tasks: what execution and its instruments operate on. */
export function activeEvalTasks(tasks: EvalTask[]): EvalTask[] {
  return tasks.filter((t) => !isRetired(t));
}

/** The curator's id convention EVAL-TASK-<issue>-<ac> — the single writer-side encoding. */
export function buildTaskId(issueId: string, acId: string): string {
  return `EVAL-TASK-${issueId}-${acId}`;
}

/**
 * Inverse of buildTaskId. `sourceIssueId` is authoritative when present; without it the id
 * itself still IS the convention — AC ids start with `AC-`, and no extra shape is imposed
 * on the issue id (the old fallback's `ISSUE-\d+` silently read other prefixes as
 * eternally 'unverified'). null = the id does not follow the convention.
 */
export function parseTaskId(
  id: string,
  sourceIssueId?: string | null,
): { issueId: string; acId: string } | null {
  if (sourceIssueId) {
    const prefix = buildTaskId(sourceIssueId, '');
    return id.startsWith(prefix) ? { issueId: sourceIssueId, acId: id.slice(prefix.length) } : null;
  }
  const m = /^EVAL-TASK-(.+?)-(AC-.+)$/.exec(id);
  return m ? { issueId: m[1]!, acId: m[2]! } : null;
}
