/**
 * Deterministic design-tier integrity checks. The "rules enforced by code" half of the
 * design layer: the author writes the design, this code guarantees the structural
 * invariants every caller must be able to trust before work is spawned. The skill
 * wrappers and the workflow run these same functions — one implementation, no
 * duplicated logic. This file is the single source; the skill copies are vendored from
 * it by `npm run bundle-skills`.
 *
 * Pure functions over *already-parsed* structured cores. Parsing the issue manifest /
 * system markdown is the wrapper's concern, so this module is format-agnostic.
 */

// --- nano tier (issue decomposition, spec cadence) --------------------------

/**
 * The machine-extractable core of one spawned Issue (DOC_TAXONOMY §NANO). The full Issue
 * Contract is drafted later; here we carry only what the structural checks need. A slice
 * and an issue are the same shape at this altitude — to-detail-design now emits an issue
 * set (no markdown slice docs); the store id is allocated when the set is spawned.
 */
export interface IssueCore {
  /** Draft-local stable key (e.g. ISSUE-TODODUE-001); the store ISSUE-NNNN id is allocated at spawn. */
  key: string;
  /** AC-IDs this issue satisfies. */
  coversAcIds: string[];
  /** Predecessor issue keys (dependency order). */
  dependsOnIssues: string[];
  /** Referenced system element ids (…-<CTX>-NNN) — referenced, never copied. */
  dependsOnSystem: string[];
}

export interface CoverageResult {
  ok: boolean;
  /** AC-IDs in the spec but covered by no issue. */
  missing: string[];
  /** AC-IDs covered by some issue but absent from the spec. */
  orphan: string[];
  /** AC-IDs covered by more than one issue (exclusivity broken). */
  duplicated: string[];
}

/**
 * Coverage AND exclusivity, bidirectional: the union of every issue's coversAcIds must
 * equal the spec's AC-ID set, and no AC may appear in more than one issue.
 */
export function checkAcCoverage(specAcIds: string[], issues: IssueCore[]): CoverageResult {
  const spec = new Set(specAcIds);
  const counts = new Map<string, number>();
  for (const s of issues) {
    for (const ac of s.coversAcIds) counts.set(ac, (counts.get(ac) ?? 0) + 1);
  }
  const missing = [...spec].filter((ac) => !counts.has(ac));
  const orphan = [...counts.keys()].filter((ac) => !spec.has(ac));
  const duplicated = [...counts.entries()].filter(([, n]) => n > 1).map(([ac]) => ac);
  return { ok: missing.length === 0 && orphan.length === 0 && duplicated.length === 0, missing, orphan, duplicated };
}

export interface UniqueResult {
  ok: boolean;
  duplicates: string[];
}

/** Issue key must be unique within the set (renumber/reuse is forbidden). */
export function checkIssueKeyUnique(issues: IssueCore[]): UniqueResult {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const s of issues) {
    if (seen.has(s.key)) dup.add(s.key);
    seen.add(s.key);
  }
  return { ok: dup.size === 0, duplicates: [...dup] };
}

export interface DagResult {
  ok: boolean;
  /** dependsOnIssues targets that are not known issue keys. */
  unknownRefs: string[];
  /** A representative cycle (empty if acyclic). */
  cycle: string[];
}

/** dependsOnIssues must reference known issues and form a DAG (no cycles). */
export function checkIssueDag(issues: IssueCore[]): DagResult {
  const ids = new Set(issues.map((s) => s.key));
  const adj = new Map<string, string[]>();
  const unknown = new Set<string>();
  for (const s of issues) {
    const deps: string[] = [];
    for (const d of s.dependsOnIssues) {
      if (ids.has(d)) deps.push(d);
      else unknown.add(d);
    }
    adj.set(s.key, deps);
  }
  // color DFS: undefined = unvisited, 1 = on-stack, 2 = done.
  const color = new Map<string, number>();
  const stack: string[] = [];
  let cycle: string[] = [];
  const visit = (node: string): boolean => {
    color.set(node, 1);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      const c = color.get(next);
      if (c === 1) {
        cycle = stack.slice(stack.indexOf(next)).concat(next);
        return true;
      }
      if (c === undefined && visit(next)) return true;
    }
    stack.pop();
    color.set(node, 2);
    return false;
  };
  for (const s of issues) {
    if (color.get(s.key) === undefined && visit(s.key)) break;
  }
  return { ok: unknown.size === 0 && cycle.length === 0, unknownRefs: [...unknown], cycle };
}

export interface RefResult {
  ok: boolean;
  /** referenced ids that are not present in the known set. */
  dangling: string[];
}

/** Referenced ids must all be present in the known set (generic reference-existence). */
export function checkReferencesPresent(referencedIds: string[], presentIds: string[]): RefResult {
  const known = new Set(presentIds);
  const dangling = [...new Set(referencedIds.filter((id) => !known.has(id)))];
  return { ok: dangling.length === 0, dangling };
}

/** Every issue's dependsOnSystem id must exist in the system layer (nano tier). */
export function checkSystemRefs(issues: IssueCore[], systemElementIds: string[]): RefResult {
  return checkReferencesPresent(
    issues.flatMap((s) => s.dependsOnSystem),
    systemElementIds,
  );
}

// --- system tier (system mode, bounded-context cadence) ---------------------

export interface AdditiveResult {
  ok: boolean;
  /** extend ids that collide with an existing element id (renumber/rewrite). */
  rewritten: string[];
}

/**
 * Additive-only: a system-layer delta may only add NEW element ids; it must not
 * reuse/renumber an existing id. (Body-rewrite detection needs a content diff against
 * the prior version and is asserted separately, not here.)
 */
export function checkAdditive(existingElementIds: string[], extendElementIds: string[]): AdditiveResult {
  const existing = new Set(existingElementIds);
  const rewritten = extendElementIds.filter((id) => existing.has(id));
  return { ok: rewritten.length === 0, rewritten };
}

// --- combined ----------------------------------------------------------------

export interface DesignLintInput {
  /** Full AC-ID set from the approved spec (coverage target). */
  specAcIds: string[];
  issues: IssueCore[];
  /** Existing system element ids (for reference existence). */
  systemElementIds: string[];
  /** Element ids this run's system delta adds (additive check); omit for issue-only runs. */
  extendElementIds?: string[];
}

export interface DesignLintResult {
  ok: boolean;
  errors: string[];
}

/** Combined deterministic design tier: coverage/exclusivity + key uniqueness + DAG + refs + additive. */
export function lintDesign(input: DesignLintInput): DesignLintResult {
  const errors: string[] = [];

  const coverage = checkAcCoverage(input.specAcIds, input.issues);
  if (coverage.missing.length) errors.push(`AC not covered by any issue: ${coverage.missing.join(', ')}`);
  if (coverage.orphan.length) errors.push(`issue covers unknown AC: ${coverage.orphan.join(', ')}`);
  if (coverage.duplicated.length) errors.push(`AC covered by >1 issue: ${coverage.duplicated.join(', ')}`);

  const unique = checkIssueKeyUnique(input.issues);
  if (!unique.ok) errors.push(`duplicate issue key: ${unique.duplicates.join(', ')}`);

  const dag = checkIssueDag(input.issues);
  if (dag.unknownRefs.length) errors.push(`dependsOnIssues references unknown issue: ${dag.unknownRefs.join(', ')}`);
  if (dag.cycle.length) errors.push(`dependency cycle: ${dag.cycle.join(' -> ')}`);

  const refs = checkSystemRefs(input.issues, input.systemElementIds);
  if (!refs.ok) errors.push(`dependsOnSystem references missing element: ${refs.dangling.join(', ')}`);

  if (input.extendElementIds && input.extendElementIds.length) {
    const additive = checkAdditive(input.systemElementIds, input.extendElementIds);
    if (!additive.ok) errors.push(`system delta rewrites existing element (not additive): ${additive.rewritten.join(', ')}`);
  }

  return { ok: errors.length === 0, errors };
}
