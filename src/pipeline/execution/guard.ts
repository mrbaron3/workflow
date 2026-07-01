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
 */

import type { Store } from '../../store/store.js';
import type { HarnessConfig } from '../../config.js';
import type { Issue } from '../../domain/schema.js';

/** Issues the execution layer may dispatch, in stable id order. */
export function pollable(store: Store, config: HarnessConfig): Issue[] {
  return store.db.issues
    .filter((i) => i.status === 'contract-drafted' && i.assignedAgent === config.generator)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** True if this single issue is in scope for autonomous processing (the guard predicate). */
export function isAiManaged(issue: Issue, config: HarnessConfig): boolean {
  return issue.status === 'contract-drafted' && issue.assignedAgent === config.generator;
}
