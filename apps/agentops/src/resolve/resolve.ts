/**
 * M05 resolve: project a version-pinned, approved `ResolvedSource` into one
 * `IssueContract` by pure join/copy — no judgement.
 *
 * The core is a pure function `(ResolvedSource, acFingerprints) -> IssueContract`.
 * Reference -> content resolution (git/file I/O) happens at the boundary and hands
 * this function an already-inlined view, so it is trivially unit-testable with
 * in-memory fixtures (no repo required) and deterministic: same input -> byte-
 * identical contract.
 *
 * Resolve refuses rather than inventing: if an output field can't be join/copied
 * from the source, that's an upstream gap, not something resolve fills in.
 */

import { z } from 'zod';
import { IssueContract } from '../domain/schema.js';
import { fingerprintAc } from '../authoring/fingerprint.js';
import { AUTO_METHODS } from '../authoring/lint.js';

/** Resolve output = IssueContract + optional tech_stack (from the system architecture element). */
export const ResolvedContract = IssueContract.extend({
  tech_stack: z.array(z.string()).optional(),
});
export type ResolvedContract = z.infer<typeof ResolvedContract>;

export interface SourceVerification {
  severity: string;
  method: string;
  expected: string[];
}

/** A version-pinned source with all refs already resolved to content (boundary's job). */
export interface ResolvedSource {
  issueType: string;
  narrative: { productGoal: string; userStory: string };
  /** The canonical AC-ID set this source declares. */
  acceptanceCriteriaIds: string[];
  /** AC-ID -> Given/When/Then behavior, from spec.md. */
  behaviorById: Record<string, string>;
  /** AC-ID -> severity + verification, from acceptance.yaml. */
  verificationById: Record<string, SourceVerification>;
  scope: { include: string[]; exclude: string[] };
  redLines: string[];
  /** From the system architecture element (greenfield only). */
  techStack?: string[];
  /** Tier2 slice coverage, for the three-way coverage check (greenfield only). */
  sliceCoversAcIds?: string[];
}

export type ResolveError =
  | { kind: 'missing'; acIds: string[] }
  | { kind: 'duplicate'; acIds: string[] }
  | { kind: 'coverage'; sliceMismatch: string[] }
  | { kind: 'manual'; acIds: string[] }
  | { kind: 'drift'; acIds: string[] }
  | { kind: 'schema'; issues: string[] };

export type ResolveResult =
  | { ok: true; contract: ResolvedContract }
  | { ok: false; error: ResolveError };

function uniqueDuplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dup.add(id);
    seen.add(id);
  }
  return [...dup];
}

function symmetricDiff(a: string[], b: string[]): string[] {
  const sa = new Set(a);
  const sb = new Set(b);
  return [...new Set([...a.filter((x) => !sb.has(x)), ...b.filter((x) => !sa.has(x))])];
}

/**
 * Resolve a source into a contract, or return a structured refusal.
 *
 * Order: structural (missing / duplicate / slice coverage) -> manual-absence ->
 * drift gate -> projection -> schema validation. Each gate refuses the whole
 * resolve (no partial contracts).
 */
export function resolve(source: ResolvedSource, acFingerprints: Record<string, string>): ResolveResult {
  const ids = source.acceptanceCriteriaIds;

  const duplicates = uniqueDuplicates(ids);
  if (duplicates.length) return { ok: false, error: { kind: 'duplicate', acIds: duplicates } };

  const missing = ids.filter((id) => source.behaviorById[id] === undefined || source.verificationById[id] === undefined);
  if (missing.length) return { ok: false, error: { kind: 'missing', acIds: missing } };

  // Three-way coverage (greenfield): source ids == slice coversAcIds.
  if (source.sliceCoversAcIds !== undefined) {
    const mismatch = symmetricDiff(ids, source.sliceCoversAcIds);
    if (mismatch.length) return { ok: false, error: { kind: 'coverage', sliceMismatch: mismatch } };
  }

  const manual = ids.filter((id) => !AUTO_METHODS.includes(source.verificationById[id]!.method));
  if (manual.length) return { ok: false, error: { kind: 'manual', acIds: manual } };

  // Drift gate: recompute each AC fingerprint and compare to the approved one.
  const drifted = ids.filter((id) => {
    const v = source.verificationById[id]!;
    const current = fingerprintAc({
      behavior: source.behaviorById[id]!,
      severity: v.severity,
      method: v.method,
      expected: v.expected,
    });
    return acFingerprints[id] !== current;
  });
  if (drifted.length) return { ok: false, error: { kind: 'drift', acIds: drifted } };

  // Projection: join behavior (spec) x severity+verification (acceptance) by AC-ID,
  // in the source's id order, so the same source yields a byte-identical contract.
  const draft: Record<string, unknown> = {
    productGoal: source.narrative.productGoal,
    userStory: source.narrative.userStory,
    scope: { include: source.scope.include, exclude: source.scope.exclude },
    acceptanceCriteria: ids.map((id) => {
      const v = source.verificationById[id]!;
      return {
        id,
        severity: v.severity,
        behavior: source.behaviorById[id]!,
        verification: { method: v.method, expected: v.expected },
      };
    }),
    redLines: source.redLines,
  };
  if (source.techStack !== undefined) draft.tech_stack = source.techStack;

  const parsed = ResolvedContract.safeParse(draft);
  if (!parsed.success) {
    return { ok: false, error: { kind: 'schema', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) } };
  }
  return { ok: true, contract: parsed.data };
}

/** Stable serialization of a resolved contract — the byte-identical determinism anchor. */
export function serializeContract(contract: ResolvedContract): string {
  return JSON.stringify(contract);
}
