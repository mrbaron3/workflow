/**
 * Deterministic design-tier integrity checks. The "rules enforced by code" half of the
 * design layer: the author writes the design, this code guarantees the structural
 * invariants every caller must be able to trust before work is spawned. The skill
 * wrappers and the workflow run these same functions — one implementation, no
 * duplicated logic. This file is the single source; the skill copies are vendored from
 * it by `npm run bundle-skills`.
 *
 * Pure functions over *already-parsed* structured cores. Parsing the slice / system
 * markdown is the wrapper's concern, so this module is format-agnostic.
 */

// --- slice tier (slice mode, epic cadence) ----------------------------------

/** The machine-extractable core of one DesignSlice (the prose lives in the .md). */
export interface SliceCore {
  sliceId: string;
  /** AC-IDs this slice satisfies. */
  coversAcIds: string[];
  /** Predecessor slice ids (dependency order). */
  dependsOnSlices: string[];
  /** Referenced system element ids (DOM/DATA/ARCH-NNN) — referenced, never copied. */
  dependsOnSystem: string[];
}

export interface CoverageResult {
  ok: boolean;
  /** AC-IDs in the spec but covered by no slice. */
  missing: string[];
  /** AC-IDs covered by some slice but absent from the spec. */
  orphan: string[];
  /** AC-IDs covered by more than one slice (exclusivity broken). */
  duplicated: string[];
}

/**
 * Coverage AND exclusivity, bidirectional: the union of every slice's coversAcIds must
 * equal the spec's AC-ID set, and no AC may appear in more than one slice.
 */
export function checkAcCoverage(specAcIds: string[], slices: SliceCore[]): CoverageResult {
  const spec = new Set(specAcIds);
  const counts = new Map<string, number>();
  for (const s of slices) {
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

/** sliceId must be unique within the epic (renumber/reuse is forbidden). */
export function checkSliceIdUnique(slices: SliceCore[]): UniqueResult {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const s of slices) {
    if (seen.has(s.sliceId)) dup.add(s.sliceId);
    seen.add(s.sliceId);
  }
  return { ok: dup.size === 0, duplicates: [...dup] };
}

export interface DagResult {
  ok: boolean;
  /** dependsOnSlices targets that are not known sliceIds. */
  unknownRefs: string[];
  /** A representative cycle (empty if acyclic). */
  cycle: string[];
}

/** dependsOnSlices must reference known slices and form a DAG (no cycles). */
export function checkSliceDag(slices: SliceCore[]): DagResult {
  const ids = new Set(slices.map((s) => s.sliceId));
  const adj = new Map<string, string[]>();
  const unknown = new Set<string>();
  for (const s of slices) {
    const deps: string[] = [];
    for (const d of s.dependsOnSlices) {
      if (ids.has(d)) deps.push(d);
      else unknown.add(d);
    }
    adj.set(s.sliceId, deps);
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
  for (const s of slices) {
    if (color.get(s.sliceId) === undefined && visit(s.sliceId)) break;
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

/** Every slice's dependsOnSystem id must exist in the global system layer (slice tier). */
export function checkSystemRefs(slices: SliceCore[], systemElementIds: string[]): RefResult {
  return checkReferencesPresent(
    slices.flatMap((s) => s.dependsOnSystem),
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
  /** Full AC-ID set from the approved spec (slice-tier coverage target). */
  specAcIds: string[];
  slices: SliceCore[];
  /** Existing global system element ids (for reference existence). */
  systemElementIds: string[];
  /** Element ids this run's system delta adds (additive check); omit for slice-only runs. */
  extendElementIds?: string[];
}

export interface DesignLintResult {
  ok: boolean;
  errors: string[];
}

/** Combined deterministic design tier: coverage/exclusivity + sliceId + DAG + refs + additive. */
export function lintDesign(input: DesignLintInput): DesignLintResult {
  const errors: string[] = [];

  const coverage = checkAcCoverage(input.specAcIds, input.slices);
  if (coverage.missing.length) errors.push(`AC not covered by any slice: ${coverage.missing.join(', ')}`);
  if (coverage.orphan.length) errors.push(`slice covers unknown AC: ${coverage.orphan.join(', ')}`);
  if (coverage.duplicated.length) errors.push(`AC covered by >1 slice: ${coverage.duplicated.join(', ')}`);

  const unique = checkSliceIdUnique(input.slices);
  if (!unique.ok) errors.push(`duplicate sliceId: ${unique.duplicates.join(', ')}`);

  const dag = checkSliceDag(input.slices);
  if (dag.unknownRefs.length) errors.push(`dependsOnSlices references unknown slice: ${dag.unknownRefs.join(', ')}`);
  if (dag.cycle.length) errors.push(`dependency cycle: ${dag.cycle.join(' -> ')}`);

  const refs = checkSystemRefs(input.slices, input.systemElementIds);
  if (!refs.ok) errors.push(`dependsOnSystem references missing element: ${refs.dangling.join(', ')}`);

  if (input.extendElementIds && input.extendElementIds.length) {
    const additive = checkAdditive(input.systemElementIds, input.extendElementIds);
    if (!additive.ok) errors.push(`system delta rewrites existing element (not additive): ${additive.rewritten.join(', ')}`);
  }

  return { ok: errors.length === 0, errors };
}
