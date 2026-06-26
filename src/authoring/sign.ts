/**
 * Sign-time assembly for the authoring layer (M20, AC-AUTH-007): turn a parsed,
 * lint-passing spec into the version-pinned ApprovedSpecRef a human signature
 * persists. Pure — git facts (commit + blob SHAs) are passed in by the caller,
 * which owns the git/file I/O and the clean-tree precondition.
 */

import type { ApprovedSpecRef } from '../domain/schema.js';
import { fingerprintAc } from './fingerprint.js';
import type { SpecScenario, SpecVerification } from './source.js';

/** AC-ID -> content fingerprint, for every AC present in BOTH spec and acceptance. */
export function computeAcFingerprints(
  scenarios: SpecScenario[],
  verifications: Record<string, SpecVerification>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of scenarios) {
    const v = verifications[s.id];
    if (!v) continue; // coverage is the lint's job; don't hash a half-defined AC
    out[s.id] = fingerprintAc({ behavior: s.behavior, severity: v.severity, method: v.method, expected: v.expected });
  }
  return out;
}

export interface GitFacts {
  signedCommitSha: string;
  specBlobGitSha: string;
  acceptanceBlobGitSha: string;
}

export interface BuildRefInput {
  scenarios: SpecScenario[];
  verifications: Record<string, SpecVerification>;
  git: GitFacts;
  /** System-layer refs the contract pins (empty on greenfield). */
  systemRefs?: string[];
}

/**
 * Build the ApprovedSpecRef: pin the signing commit + blob SHAs, fingerprint every
 * AC, and approve the full current AC set in document order. The caller must have
 * run the AUTH-B lint first — this assumes a coherent contract.
 */
export function buildApprovedSpecRef(input: BuildRefInput): ApprovedSpecRef {
  return {
    signedCommitSha: input.git.signedCommitSha,
    specBlobGitSha: input.git.specBlobGitSha,
    acceptanceBlobGitSha: input.git.acceptanceBlobGitSha,
    acFingerprints: computeAcFingerprints(input.scenarios, input.verifications),
    systemRefs: input.systemRefs ?? [],
    approvedAcIds: input.scenarios.map((s) => s.id),
  };
}
