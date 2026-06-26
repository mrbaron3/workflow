/**
 * Boundary loader for the authoring layer: parse one spec dir's human-authored
 * spec.md + acceptance.yaml into per-AC behavior (Given/When/Then) and grading.
 *
 * This is the "parse the markdown / yaml" concern that lint.ts and fingerprint.ts
 * deliberately keep out of their pure cores (see lint.ts header). The signing gate
 * (M20) feeds this into fingerprintAc; the resolve boundary (M05) can build its
 * ResolvedSource from the same shape. File/git I/O stays in the caller.
 */

import { parse as parseYaml } from 'yaml';

/** Anchor of one acceptance-criteria scenario: `- **[AC-FOO-001] title**`. */
const AC_ANCHOR = /^\s*-\s+\*\*\[(AC-[A-Z0-9]+-\d+)\]\s*(.*?)\*\*\s*$/;
/** A markdown heading — ends the current scenario block. */
const HEADING = /^#{1,6}\s/;
/** A standalone bold section label (e.g. `**非機能要件**`) — also ends a scenario. */
const BOLD_SECTION = /^\s*\*\*[^*]+\*\*\s*$/;

export interface SpecScenario {
  id: string;
  /** Title + Given/When/Then body, AC-ID stripped (raw text; fingerprinting normalizes whitespace). */
  behavior: string;
}

/**
 * Extract one scenario per AC-ID anchor, capturing its title and the lines below
 * it up to the next anchor / heading / bold section / EOF. Document order is
 * preserved; the AC-ID itself is identity, not content, so it is left out of the
 * behavior text.
 */
export function parseSpecScenarios(specText: string): SpecScenario[] {
  const scenarios: SpecScenario[] = [];
  let current: { id: string; buf: string[] } | null = null;
  const flush = () => {
    if (current) scenarios.push({ id: current.id, behavior: current.buf.join('\n').trim() });
    current = null;
  };
  for (const line of specText.split('\n')) {
    const m = AC_ANCHOR.exec(line);
    if (m) {
      flush();
      current = { id: m[1]!, buf: [m[2]!.trim()] }; // seed with the title text
      continue;
    }
    if (current && (HEADING.test(line) || BOLD_SECTION.test(line))) {
      flush();
      continue;
    }
    if (current) current.buf.push(line);
  }
  flush();
  return scenarios;
}

export interface SpecVerification {
  severity: string;
  method: string;
  expected: string[];
}

/** Parse acceptance.yaml's `verifications:` map into AC-ID -> verification. */
export function parseAcceptance(acceptanceText: string): Record<string, SpecVerification> {
  const doc = (parseYaml(acceptanceText) ?? {}) as {
    verifications?: Record<string, { severity?: string; method?: string; expected?: string[] }>;
  };
  const out: Record<string, SpecVerification> = {};
  for (const [id, v] of Object.entries(doc.verifications ?? {})) {
    out[id] = {
      severity: v?.severity ?? '',
      method: v?.method ?? '',
      expected: Array.isArray(v?.expected) ? v!.expected! : [],
    };
  }
  return out;
}
