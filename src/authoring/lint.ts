/**
 * Deterministic AC-ID integrity checks enforced at the signing gate (M20) and
 * re-asserted at resolve (M05). This is the "厳格さはコードで強制" half of the
 * authoring layer (ADR-0005): the human writes WHAT, the code guarantees that the
 * acceptance criteria are well-formed before anything downstream consumes them.
 *
 * These are pure functions over *already-parsed* AC-IDs and methods — parsing the
 * Given/When/Then markdown of spec.md is a separate concern. Cross-version
 * "no renumber across signatures" needs git history and is checked at the gate
 * against the prior approvedAcIds; here we catch in-document duplicates.
 */

import { VerificationMethod } from '../domain/schema.js';

/** Auto-gradable methods — everything except `manual` (which is not an allowed grader method). */
export const AUTO_METHODS: readonly string[] = VerificationMethod.options.filter((m) => m !== 'manual');

export interface CoverageResult {
  ok: boolean;
  /** AC-IDs in spec.md but missing from acceptance.yaml. */
  missingInAcceptance: string[];
  /** AC-ID keys in acceptance.yaml but missing from spec.md. */
  missingInSpec: string[];
}

/** Bidirectional coverage: spec.md AC-IDs and acceptance.yaml keys must be the same set. */
export function checkCoverage(specAcIds: string[], acceptanceAcIds: string[]): CoverageResult {
  const spec = new Set(specAcIds);
  const acc = new Set(acceptanceAcIds);
  const missingInAcceptance = [...spec].filter((id) => !acc.has(id));
  const missingInSpec = [...acc].filter((id) => !spec.has(id));
  return {
    ok: missingInAcceptance.length === 0 && missingInSpec.length === 0,
    missingInAcceptance,
    missingInSpec,
  };
}

export interface DuplicateResult {
  ok: boolean;
  duplicates: string[];
}

/** No AC-ID is reused within a document (renumber/reuse is forbidden). */
export function checkNoReuse(acIds: string[]): DuplicateResult {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of acIds) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return { ok: duplicates.size === 0, duplicates: [...duplicates] };
}

export interface ManualResult {
  ok: boolean;
  manualAcIds: string[];
}

/** Every acceptance method must be auto-gradable; non-auto requirements are surfaced in chat, not graded. */
export function checkManualAbsence(methodsById: Record<string, string>): ManualResult {
  const manualAcIds = Object.entries(methodsById)
    .filter(([, method]) => !AUTO_METHODS.includes(method))
    .map(([id]) => id);
  return { ok: manualAcIds.length === 0, manualAcIds };
}

export interface AuthoringLintInput {
  /** AC-IDs extracted from spec.md (in document order, possibly with duplicates). */
  specAcIds: string[];
  /** AC-ID keys of acceptance.yaml. */
  acceptanceAcIds: string[];
  /** AC-ID -> verification method, from acceptance.yaml. */
  methodsById: Record<string, string>;
}

export interface AuthoringLintResult {
  ok: boolean;
  errors: string[];
  coverage: CoverageResult;
  duplicates: DuplicateResult;
  manual: ManualResult;
}

/** Combined signing-gate lint: coverage + no-reuse + manual-absence. */
export function lintAuthoring(input: AuthoringLintInput): AuthoringLintResult {
  const coverage = checkCoverage(input.specAcIds, input.acceptanceAcIds);
  const duplicates = checkNoReuse(input.specAcIds);
  const manual = checkManualAbsence(input.methodsById);
  const errors: string[] = [];
  if (!coverage.ok) {
    if (coverage.missingInAcceptance.length)
      errors.push(`AC in spec.md but not acceptance.yaml: ${coverage.missingInAcceptance.join(', ')}`);
    if (coverage.missingInSpec.length)
      errors.push(`AC in acceptance.yaml but not spec.md: ${coverage.missingInSpec.join(', ')}`);
  }
  if (!duplicates.ok) errors.push(`duplicate AC-IDs: ${duplicates.duplicates.join(', ')}`);
  if (!manual.ok) errors.push(`manual method not allowed in acceptance.yaml: ${manual.manualAcIds.join(', ')}`);
  return { ok: errors.length === 0, errors, coverage, duplicates, manual };
}
