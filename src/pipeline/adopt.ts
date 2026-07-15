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
import { resolvedGeneratorProvider } from '../agents/routing.js';

export interface AdoptInput {
  /**
   * Raw contract (e.g. parsed YAML) — validated against IssueContract here, loudly.
   * Omitted = use the DRAFT the Analyst attached to the proposal (still validated);
   * adopting is the human confirmation either way.
   */
  contract?: unknown;
  /** Optional system design ids the generator's scoped context should resolve. */
  dependsOnSystem?: string[];
}

export function adoptIssue(store: Store, config: HarnessConfig, issueId: string, input: AdoptInput = {}): Issue {
  const issue = store.getIssue(issueId);
  if (!issue) throw new Error(`no such issue: ${issueId}`);
  if (issue.status !== 'planned' && issue.status !== 'ready-for-contract') {
    throw new Error(
      `${issueId} is '${issue.status}' — adopt only confirms a proposal (planned/ready-for-contract) into drivable work`,
    );
  }
  const raw = input.contract ?? issue.contract;
  if (!raw) throw new Error(`${issueId} has no contract: the proposal carries no draft — pass one via --contract`);
  const contract = IssueContract.parse(raw); // an invalid WHAT never reaches the loop

  if (issue.status === 'planned') store.setStatus(issueId, 'ready-for-contract');
  store.setStatus(issueId, 'contract-drafted');
  return store.updateIssue(issueId, {
    contract,
    assignedAgent: resolvedGeneratorProvider(config),
    ...(input.dependsOnSystem ? { dependsOnSystem: input.dependsOnSystem } : {}),
  });
}
