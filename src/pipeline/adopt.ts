/**
 * Adopt an improvement proposal into drivable work (ADR-0007 I1).
 *
 * The Analyst only *proposes*: its issues land as `planned` with no contract, which the
 * execution guard (DOM-execution-006) deliberately never polls. Adoption is the human
 * WHAT-confirmation point: a person sharpens the proposal into an IssueContract and adopts
 * it, and THAT is what flips the issue into the ai-managed shape the drive loop picks up —
 * contract attached (Zod-validated), status walked planned → ready-for-contract →
 * contract-drafted through the state machine, assignedAgent set to the configured backend.
 * No dedicated improvement pipeline: an adopted harness issue rides the same
 * generate → panel → gate loop as feature work.
 */

import { IssueContract, type Issue } from '../domain/schema.js';
import type { HarnessConfig } from '../config.js';
import type { Store } from '../store/store.js';

export interface AdoptInput {
  /** Raw contract (e.g. parsed YAML) — validated against IssueContract here, loudly. */
  contract: unknown;
  /** Optional system design ids the generator's scoped context should resolve. */
  dependsOnSystem?: string[];
}

export function adoptIssue(store: Store, config: HarnessConfig, issueId: string, input: AdoptInput): Issue {
  const issue = store.getIssue(issueId);
  if (!issue) throw new Error(`no such issue: ${issueId}`);
  if (issue.status !== 'planned' && issue.status !== 'ready-for-contract') {
    throw new Error(
      `${issueId} is '${issue.status}' — adopt only confirms a proposal (planned/ready-for-contract) into drivable work`,
    );
  }
  const contract = IssueContract.parse(input.contract); // an invalid WHAT never reaches the loop

  if (issue.status === 'planned') store.setStatus(issueId, 'ready-for-contract');
  store.setStatus(issueId, 'contract-drafted');
  return store.updateIssue(issueId, {
    contract,
    assignedAgent: config.generator,
    ...(input.dependsOnSystem ? { dependsOnSystem: input.dependsOnSystem } : {}),
  });
}
