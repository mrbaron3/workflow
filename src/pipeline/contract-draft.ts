/**
 * The contract-drafting bridge (docs/specs/contract-drafting): turn issues spawned from a
 * *signed* spec (planned, with coversAcIds, contract=null) into runnable issues by drafting
 * an Issue Contract whose acceptance criteria are **sourced from the signed spec** — never
 * re-authored here — and advancing them planned → contract-drafted.
 *
 * This closes the seam between spawnIssues (spec → store) and the run loop (which needs a
 * contract-drafted issue). It is deterministic and idempotent; the eligibility gates encode
 * the spec's red lines (AC-CONTRACT-003/004): never draft from an unsigned spec, never from a
 * coversAcIds that drifted out of the signed AC set.
 */

import fs from 'node:fs';
import path from 'node:path';
import { IssueContract, type AcceptanceCriterion } from '../domain/schema.js';
import { parseSpecScenarios, parseAcceptance, type SpecVerification } from '../authoring/source.js';
import { Store } from '../store/store.js';

export interface DraftContractsResult {
  drafted: number;
  ids: string[]; // issues advanced to contract-drafted, in store order (empty when nothing eligible)
}

/** Pull the spec's H1 title (the feature name) as the contract's product goal. */
function specTitle(specText: string, fallback: string): string {
  for (const line of specText.split('\n')) {
    const m = /^#\s+(.*\S)\s*$/.exec(line);
    if (m) return m[1]!;
  }
  return fallback;
}

/** Extract the spec's red-line bullets (the section under a レッドライン / "Red line" heading). */
function redLines(specText: string): string[] {
  const lines = specText.split('\n');
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      inSection = /レッドライン|red\s*line/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const m = /^\s*-\s+(.*\S)\s*$/.exec(line); // bullets only; skip `>` quote/intro lines
    if (m) out.push(m[1]!);
  }
  return out;
}

/** Build one AcceptanceCriterion for an AC-ID from the signed spec's scenario + verification. */
function criterionFor(
  ac: string,
  behaviorById: Map<string, string>,
  verifications: Record<string, SpecVerification>,
): AcceptanceCriterion {
  const v = verifications[ac];
  if (!v) throw new Error(`signed spec has no verification for ${ac} (acceptance.yaml out of sync?)`);
  // IssueContract.parse validates severity/method against the schema enums.
  return {
    id: ac,
    severity: v.severity as AcceptanceCriterion['severity'],
    behavior: behaviorById.get(ac) ?? ac,
    verification: { method: v.method as AcceptanceCriterion['verification']['method'], expected: v.expected },
  };
}

/**
 * Draft Issue Contracts for every planned issue spawned from `specDir`'s signed spec.
 * Scoped to this spec's issues (AC-CONTRACT-006); idempotent — already-drafted issues are
 * left untouched (AC-CONTRACT-005). Validates all gates before any mutation so a violation
 * persists nothing (AC-CONTRACT-003/004).
 */
export function draftContracts(store: Store, specDir: string): DraftContractsResult {
  const specAbs = path.resolve(store.root, specDir);
  const specPath = path.relative(store.root, specAbs).split(path.sep).join('/');

  // Gate: the spec must be signed — contracts draft from a signed WHAT (AC-CONTRACT-003).
  const approved = store.getSpecState(specPath)?.approved;
  if (!approved) {
    throw new Error(`spec is not signed: ${specPath} — contracts draft from a signed WHAT (sign it first)`);
  }

  const specText = fs.readFileSync(path.join(specAbs, 'spec.md'), 'utf8');
  const verifications = parseAcceptance(fs.readFileSync(path.join(specAbs, 'acceptance.yaml'), 'utf8'));
  const behaviorById = new Map(parseSpecScenarios(specText).map((s) => [s.id, s.behavior]));
  const approvedSet = new Set(approved.approvedAcIds);
  const goal = specTitle(specText, specPath);
  const reds = redLines(specText);

  // This spec's not-yet-drafted issues only (AC-CONTRACT-005 idempotency, AC-CONTRACT-006 scope).
  const targets = store.db.issues.filter((i) => i.specPath === specPath && i.status === 'planned');

  // Gate: every covered AC must be in the signed AC set — validate ALL before mutating, so a drift
  // violation leaves this spec's issues entirely unchanged (AC-CONTRACT-004, all-or-nothing).
  for (const issue of targets) {
    for (const ac of issue.coversAcIds) {
      if (!approvedSet.has(ac)) {
        throw new Error(
          `issue ${issue.id} covers ${ac}, which is not in the signed AC set of ${specPath} (re-sign drift?)`,
        );
      }
    }
  }

  const ids: string[] = [];
  for (const issue of targets) {
    // Acceptance criteria are SOURCED from the signed spec, bidirectional with coversAcIds — not
    // re-authored here (AC-CONTRACT-002).
    const acceptanceCriteria = issue.coversAcIds.map((ac) => criterionFor(ac, behaviorById, verifications));
    const contract = IssueContract.parse({
      productGoal: goal,
      userStory: issue.title,
      scope: { include: issue.coversAcIds, exclude: [] },
      acceptanceCriteria,
      redLines: reds,
    });
    store.updateIssue(issue.id, { contract });
    store.setStatus(issue.id, 'ready-for-contract');
    store.setStatus(issue.id, 'contract-drafted');
    ids.push(issue.id);
  }
  return { drafted: ids.length, ids };
}
