/**
 * AC-level content fingerprint, shared by the authoring layer (M20, at sign time)
 * and the resolve layer (M05, at dispatch time).
 *
 * Identity (the stable AC-ID) and change-detection (this hash) are deliberately
 * separate: the AC-ID never changes, but its *content* hash changes whenever the
 * approved behavior / severity / verification changes. M20 pins these hashes at
 * sign time (`acFingerprints`); M05 recomputes them at dispatch and blocks resolve
 * on any mismatch (drift). Same content -> same hash, byte for byte, every time.
 *
 * Hash input is the *approved meaning* of one acceptance criterion:
 *   - behavior   : the Given/When/Then scenario text from spec.md (human WHAT)
 *   - severity   : from acceptance.yaml
 *   - method     : from acceptance.yaml (auto grader method)
 *   - expected[] : from acceptance.yaml
 */

import { createHash } from 'node:crypto';

export interface AcFingerprintInput {
  /** Given/When/Then scenario text from spec.md. */
  behavior: string;
  severity: string;
  method: string;
  expected: string[];
}

/** Collapse runs of whitespace and trim, so cosmetic reflow does not change identity. */
function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Deterministic sha256 hex of one acceptance criterion's approved meaning. */
export function fingerprintAc(input: AcFingerprintInput): string {
  const canonical = JSON.stringify({
    behavior: normalizeText(input.behavior),
    severity: input.severity.trim(),
    method: input.method.trim(),
    expected: input.expected.map(normalizeText),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
