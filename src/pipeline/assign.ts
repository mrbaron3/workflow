/**
 * Assign a spec-spawned issue to the AI backend — the upstream chain's delegation opt-in.
 *
 * spawn-issues → contract-draft leaves an issue contract-drafted with assignedAgent=null:
 * the sign gate confirmed the WHAT, but the execution guard (DOM-execution-006) deliberately
 * never polls unassigned work — default non-processing, opt-in only. Delegating the HOW to
 * an AI backend is a separate human decision from signing the WHAT (assignedAgent could as
 * well be a human dev). assignIssue is that decision made explicit: the contract and status
 * were produced and validated upstream, so the ONLY mutation here is assignedAgent =
 * config.generator — after which the same pollable predicate that drives adopted
 * improvements (adopt.ts) picks the spec-driven issue up. No special pipeline.
 */

import type { Issue } from '../domain/schema.js';
import type { HarnessConfig } from '../config.js';
import type { Store } from '../store/store.js';
import { resolvedGeneratorProvider } from '../agents/routing.js';

export function assignIssue(store: Store, config: HarnessConfig, issueId: string): Issue {
  const issue = store.getIssue(issueId);
  if (!issue) throw new Error(`no such issue: ${issueId}`);
  if (issue.status !== 'contract-drafted') {
    throw new Error(
      `${issueId} is '${issue.status}' — assign delegates a contract-drafted issue (a proposal is adopted, not assigned)`,
    );
  }
  if (!issue.contract) {
    throw new Error(`${issueId} has no contract: contract-draft it from its signed spec first`);
  }
  return store.updateIssue(issueId, { assignedAgent: resolvedGeneratorProvider(config) });
}
