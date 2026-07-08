/**
 * The decline/retire organs (FEAT-005) — adopt's missing counterpart, so inventory circulates.
 *
 * Both are human JUDGMENT POINTS in the FEAT-004 sense (alongside adopt / assign / sign /
 * decide / label): explicit, reason-mandatory, and NOT interventions — no INTERVENTION_KINDS
 * entry exists for them, and nothing in the Analyst / improveTick / drive loop may call them
 * (proposing a retirement is free; confirming it is a person's act). Each is the SINGLE
 * mutation point for its state and persists immediately: a decline/retirement is a durable
 * store fact (ARCH-evaluation-008), auditable with its reason and time from the db alone.
 *
 * Terminal means terminal, never erasure: a closed issue and a retired task keep their
 * records — the guard/adopt/assign refuse a closed issue, execution and the executed/
 * unverified accounting exclude a retired task, but capture history (regressionCaptureRate)
 * and the audit trail are untouched. `released` is history, not a judgment, so it can never
 * be overwritten by a decline.
 */

import type { EvalTask, Issue } from '../domain/schema.js';
import { isRetired } from '../domain/eval-task.js';
import { Store, nowISO } from '../store/store.js';

export interface DeclineInput {
  issueId: string;
  /** Why the human is retiring this issue — mandatory; the audit trail depends on it. */
  reason: string;
}

/** Decline an issue: non-terminal → terminal `closed`, with the reason/time persisted. */
export function declineIssue(store: Store, input: DeclineInput): Issue {
  const reason = input.reason?.trim();
  if (!reason) throw new Error(`decline requires a reason: ${input.issueId} was given none`);
  const issue = store.getIssue(input.issueId);
  if (!issue) throw new Error(`no such issue: ${input.issueId}`);
  if (issue.status === 'released') {
    throw new Error(`${input.issueId} is released — history is immutable, a released issue cannot be declined`);
  }
  if (issue.status === 'closed') {
    throw new Error(`${input.issueId} is already closed (${issue.closedReason ?? 'no reason recorded'}) — a decline is terminal`);
  }
  store.setStatus(input.issueId, 'closed');
  const updated = store.updateIssue(input.issueId, { closedReason: reason, closedAt: nowISO() });
  store.save(); // a judgment is a durable fact the moment it is made
  return updated;
}

/**
 * Seam-pinned alias: the acceptance guard (protectedPaths) imports `closeIssue` — the name
 * pins the seam, `declineIssue` carries the organ's domain verb (gate pin, ISSUE-0012).
 */
export const closeIssue = declineIssue;

export interface RetireInput {
  taskId: string;
  /** Why the task lost its guard value — mandatory; travels with every future report. */
  reason: string;
}

/** Retire a regression eval task from execution: the record (and capture history) stays. */
export function retireEvalTask(store: Store, input: RetireInput): EvalTask {
  const reason = input.reason?.trim();
  if (!reason) throw new Error(`retire requires a reason: ${input.taskId} was given none`);
  const task = store.getEvalTask(input.taskId);
  if (!task) throw new Error(`no such eval task: ${input.taskId}`);
  if (isRetired(task)) {
    throw new Error(`${input.taskId} is already retired (${task.retiredReason ?? 'no reason recorded'})`);
  }
  const updated = store.updateEvalTask(input.taskId, { retiredReason: reason, retiredAt: nowISO() });
  store.save();
  return updated;
}
