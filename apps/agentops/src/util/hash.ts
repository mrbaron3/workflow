/**
 * Deterministic hashing for *reproducible* mock runs.
 *
 * An eval harness whose results wobble run-to-run can't be trusted, so the mock
 * backend derives all its "randomness" from a string seed (issue + sample + attempt)
 * rather than Math.random(). Same inputs -> same artifact -> same scorecard, every time.
 */

/** FNV-1a 32-bit hash of a string, returned as an unsigned 32-bit int. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic float in [0, 1) from a string seed. */
export function hashUnit(s: string): number {
  return (hash32(s) % 1_000_000) / 1_000_000;
}
