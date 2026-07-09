/**
 * Scoping guard (ARCH-execution-002, realising DOM-execution-006).
 *
 * The execution layer only ever touches issues that were explicitly opted in for
 * autonomous processing: `contract-drafted` AND assigned to the running agent
 * (`assignedAgent` == the AI backend = "ai-managed"). Issues someone else created, or
 * left unassigned, are never picked up — default non-processing, opt-in only. This is
 * the invariant that keeps a watch daemon from grabbing work it was never handed.
 *
 * It is deliberately a NEW entry point rather than a change to `coordinator.runAll`
 * (which the mock demo/tests still drive over every contract-drafted issue): the guard
 * belongs to the execution context's poll predicate, additive to the existing loop.
 *
 * The guard also respects the spec's issue DAG (ISSUE-0018): an opted-in issue whose
 * `dependsOnIssues` are not all `released` is held back — and reported, never silently
 * dropped (`blockedByDependencies`).
 */

import type { Store } from '../../store/store.js';
import type { HarnessConfig } from '../../config.js';
import type { Issue } from '../../domain/schema.js';

/** One unreleased predecessor an issue waits on: its id and CURRENT status. */
export interface DependencyWait {
  dependencyId: string;
  /** The dependency's current status; 'missing' when no such issue exists in the store. */
  status: Issue['status'] | 'missing';
}

/** Why one ai-managed issue is held back from the pollable queue (AC-DAG-001, never silent). */
export interface DependencyBlock {
  issueId: string;
  waitingOn: DependencyWait[];
}

/**
 * The unreleased predecessors of one issue (empty = dependencies satisfied). A dependency
 * that does not exist in the store can never release, so it blocks too — visibly, as
 * status 'missing', never as a silent disappearance.
 */
export function unreleasedDependencies(store: Store, issue: Issue): DependencyWait[] {
  return issue.dependsOnIssues
    .map((depId): DependencyWait => ({ dependencyId: depId, status: store.getIssue(depId)?.status ?? 'missing' }))
    .filter((w) => w.status !== 'released');
}

/**
 * Issues the execution layer may dispatch, in stable id order. Dependency-aware
 * (AC-DAG-001/002): an issue whose dependsOnIssues are not all `released` is held back
 * until they are — a deps-empty issue behaves exactly as before. Blocking is a poll-time
 * predicate, never a status transition, so a release upstream unblocks the dependent on
 * the very next poll with no human re-registration.
 */
export function pollable(store: Store, config: HarnessConfig): Issue[] {
  return store.db.issues
    .filter((i) => isAiManaged(i, config) && unreleasedDependencies(store, i).length === 0)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** True if this single issue is in scope for autonomous processing (the guard predicate). */
export function isAiManaged(issue: Issue, config: HarnessConfig): boolean {
  return issue.status === 'contract-drafted' && issue.assignedAgent === config.generator;
}

/** One human-readable line for a wait list: "ISSUE-A (planned), ISSUE-F (closed)". */
export function formatDependencyWaits(waits: DependencyWait[]): string {
  return waits.map((w) => `${w.dependencyId} (${w.status})`).join(', ');
}

/**
 * THE block line (AC-DAG-001): the one shape both the deterministic (`runAll`) and
 * live (`runLoopLive`) paths log for a dependency-held issue, so they cannot drift.
 */
export function formatBlockedLine(issueId: string, waits: DependencyWait[]): string {
  return `⧗ ${issueId} blocked: waiting on ${formatDependencyWaits(waits)}`;
}

/**
 * The never-silent half of the dependency guard (AC-DAG-001): every ai-managed issue
 * that `pollable` holds back because a predecessor is unreleased, each naming the
 * dependency ids and their CURRENT statuses. Machine-readable so callers (the live
 * turn log, dashboards) surface the block instead of letting the issue quietly vanish
 * from the queue. Same opt-in scope as `pollable` — issues not ai-managed are outside
 * the guard entirely, so they are not reported here either.
 */
export function blockedByDependencies(store: Store, config: HarnessConfig): DependencyBlock[] {
  return store.db.issues
    .filter((i) => isAiManaged(i, config))
    .map((i) => ({ issueId: i.id, waitingOn: unreleasedDependencies(store, i) }))
    .filter((b) => b.waitingOn.length > 0)
    .sort((a, b) => a.issueId.localeCompare(b.issueId));
}
