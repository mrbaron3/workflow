/**
 * Deterministic AC-ID integrity checks enforced at the signing gate (M20) and
 * re-asserted at resolve (M05). This is the "厳格さはコードで強制" half of the
 * authoring layer: the human writes WHAT, the code guarantees that the
 * acceptance criteria are well-formed before anything downstream consumes them.
 *
 * These are pure functions over *already-parsed* AC-IDs and methods — parsing the
 * Given/When/Then markdown of spec.md is a separate concern. Cross-version
 * "no renumber across signatures" needs git history and is checked at the gate
 * against the prior approvedAcIds; here we catch in-document duplicates.
 */

/**
 * Allowed acceptance verification methods — the single source for this list. Kept here
 * (a dependency-free leaf) so this lint can be vendored into a self-contained skill; the
 * contract schema imports this list to build its enum.
 */
export const VERIFICATION_METHODS = [
  'build',
  'typecheck',
  'unit_test',
  'api_test',
  'db_state_check',
  'playwright',
  'secrets_scan',
  'scope_check',
  'llm_rubric',
  'manual',
] as const;

/** Auto-gradable methods — everything except `manual` (which is not an allowed grader method). */
export const AUTO_METHODS: readonly string[] = VERIFICATION_METHODS.filter((m) => m !== 'manual');

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

/** A system-layer id a spec may depend on: a context-segmented element, or a cross-cutting NFR. */
const DEPENDS_ON_RE = /^(?:(?:LANG|DOM|ARCH|DATA|CONTRACT)-[a-z0-9]+(?:-[a-z0-9]+)*-\d+|NFR-\d+)$/;
/** A well-formed acceptance-criterion id. */
const AC_ID_RE = /^AC-[A-Z0-9]+-\d+$/;

export interface DependsOnResult {
  ok: boolean;
  /** ids that are not a valid LANG/DOM/ARCH/DATA/CONTRACT-<ctx>-NNN or NFR-NNN. */
  malformed: string[];
}

/**
 * dependsOn entries must be well-formed system-layer ids. Existence (do they actually exist in the
 * system layer?) is intentionally NOT checked here: it is pinned later at sign/resolve (systemRefs),
 * and on greenfield the referenced elements may not be seeded yet.
 */
export function checkDependsOn(dependsOn: string[]): DependsOnResult {
  const malformed = dependsOn.filter((id) => !DEPENDS_ON_RE.test(id));
  return { ok: malformed.length === 0, malformed };
}

export interface SupersedesResult {
  ok: boolean;
  /** supersedes entries that are not a well-formed AC-ID. */
  malformed: string[];
  /** superseded ids that are this spec's own current AC-IDs (you can only supersede *past* ACs). */
  selfSuperseded: string[];
}

/**
 * supersedes edges are the fold key (DOC_LIFECYCLE): each points at a PAST AC-ID this spec replaces.
 * They must be well-formed AC-IDs and must not name this spec's own current ACs — you supersede
 * history, not yourself. The actual fold (resolving edges to the live AC set) is a separate, deferred
 * mechanism; here we only guard the edges are well-formed.
 */
export function checkSupersedes(supersedes: string[], currentAcIds: string[]): SupersedesResult {
  const current = new Set(currentAcIds);
  const malformed = supersedes.filter((id) => !AC_ID_RE.test(id));
  const selfSuperseded = supersedes.filter((id) => current.has(id));
  return { ok: malformed.length === 0 && selfSuperseded.length === 0, malformed, selfSuperseded };
}

export interface AuthoringLintInput {
  /** AC-IDs extracted from spec.md (in document order, possibly with duplicates). */
  specAcIds: string[];
  /** AC-ID keys of acceptance.yaml. */
  acceptanceAcIds: string[];
  /** AC-ID -> verification method, from acceptance.yaml. */
  methodsById: Record<string, string>;
  /** Spec-level system refs from acceptance.yaml (optional; shape-validated when present). */
  dependsOn?: string[];
  /** Past AC-IDs this spec's ACs replace, flattened across ACs (optional; the fold key). */
  supersedes?: string[];
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

  if (input.dependsOn?.length) {
    const dep = checkDependsOn(input.dependsOn);
    if (!dep.ok)
      errors.push(
        `malformed dependsOn id (expect LANG/DOM/ARCH/DATA/CONTRACT-<ctx>-NNN or NFR-NNN): ${dep.malformed.join(', ')}`,
      );
  }
  if (input.supersedes?.length) {
    const sup = checkSupersedes(input.supersedes, input.specAcIds);
    if (sup.malformed.length) errors.push(`malformed supersedes AC-ID: ${sup.malformed.join(', ')}`);
    if (sup.selfSuperseded.length)
      errors.push(`supersedes lists this spec's own AC (supersede only past ACs): ${sup.selfSuperseded.join(', ')}`);
  }

  return { ok: errors.length === 0, errors, coverage, duplicates, manual };
}
