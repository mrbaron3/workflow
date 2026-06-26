import { describe, it, expect } from 'vitest';
import { fingerprintAc } from '../src/authoring/fingerprint.js';
import {
  deriveStatus,
  diffApprovedAcs,
  evaluateDrift,
  type ApprovedSnapshot,
} from '../src/authoring/drift.js';

// --- A1: status derivation (AC-AUTH-008) -------------------------------------

describe('deriveStatus (AC-AUTH-008)', () => {
  it('is approved iff approvedAcIds cover the current AC set', () => {
    expect(deriveStatus(['A', 'B'], ['A', 'B'])).toBe('approved');
    expect(deriveStatus(['A', 'B', 'C'], ['A', 'B'])).toBe('approved'); // superset is fine
  });

  it('derives co-authoring on any coverage shortfall', () => {
    expect(deriveStatus(['A'], ['A', 'B'])).toBe('co-authoring');
    expect(deriveStatus([], ['A'])).toBe('co-authoring');
  });
});

// --- A2: AC-level fingerprint diff (AC-AUTH-009/010/011 core) -----------------

describe('diffApprovedAcs', () => {
  it('classifies changed / added / removed by content, not just by ID', () => {
    const approved = { A: 'h1', B: 'h2', C: 'h3' };
    const current = { A: 'h1', B: 'CHANGED', D: 'h4' }; // B edited, C removed, D added
    const d = diffApprovedAcs(current, approved);
    expect(d.changed).toEqual(['B']);
    expect(d.added).toEqual(['D']);
    expect(d.removed).toEqual(['C']);
  });

  it('sees no drift when every fingerprint matches', () => {
    const fp = { A: 'h1', B: 'h2' };
    expect(diffApprovedAcs(fp, fp)).toEqual({ changed: [], added: [], removed: [] });
  });
});

// --- composition: the AUTH-D outcomes (AC-AUTH-009/010/011) -------------------

/** Three signed ACs, fingerprinted at sign time — the shared starting point. */
function signedThree(): { approved: ApprovedSnapshot; behavior: Record<string, string> } {
  const behavior = {
    'AC-X-001': 'Given a When b Then c',
    'AC-X-002': 'Given d When e Then f',
    'AC-X-003': 'Given g When h Then i',
  };
  const fp = (b: string) => fingerprintAc({ behavior: b, severity: 'blocker', method: 'api_test', expected: ['x'] });
  const fingerprints = Object.fromEntries(Object.entries(behavior).map(([id, b]) => [id, fp(b)]));
  return { approved: { approvedAcIds: Object.keys(behavior), fingerprints }, behavior };
}

const reFingerprint = (behavior: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(behavior).map(([id, b]) => [
      id,
      fingerprintAc({ behavior: b, severity: 'blocker', method: 'api_test', expected: ['x'] }),
    ]),
  );

describe('evaluateDrift (AUTH-D)', () => {
  it('AC-AUTH-009: editing one AC invalidates only that AC and drops status', () => {
    const { approved, behavior } = signedThree();
    const edited = { ...behavior, 'AC-X-002': 'Given d When e Then DIFFERENT' };
    const r = evaluateDrift(approved, { acIds: Object.keys(edited), fingerprints: reFingerprint(edited) });
    expect(r.changed).toEqual(['AC-X-002']);
    expect(r.retainedApprovedAcIds).toEqual(['AC-X-001', 'AC-X-003']); // untouched ACs keep their signature
    expect(r.status).toBe('co-authoring'); // the edited AC is now uncovered
  });

  it('AC-AUTH-010: adding an AC downgrades status via coverage shortfall', () => {
    const { approved, behavior } = signedThree();
    const added = { ...behavior, 'AC-X-004': 'Given j When k Then l' };
    const r = evaluateDrift(approved, { acIds: Object.keys(added), fingerprints: reFingerprint(added) });
    expect(r.added).toEqual(['AC-X-004']);
    expect(r.retainedApprovedAcIds).toEqual(['AC-X-001', 'AC-X-002', 'AC-X-003']);
    expect(r.status).toBe('co-authoring');
  });

  it('AC-AUTH-011: deleting an AC prunes it and keeps the rest approved', () => {
    const { approved, behavior } = signedThree();
    const { 'AC-X-003': _gone, ...remaining } = behavior;
    const r = evaluateDrift(approved, { acIds: Object.keys(remaining), fingerprints: reFingerprint(remaining) });
    expect(r.removed).toEqual(['AC-X-003']);
    expect(r.retainedApprovedAcIds).toEqual(['AC-X-001', 'AC-X-002']);
    expect(r.status).toBe('approved'); // remaining coverage is complete -> no re-sign needed
  });

  it('a cosmetic-only reflow of an AC is not drift', () => {
    const { approved, behavior } = signedThree();
    const reflowed = { ...behavior, 'AC-X-001': '  Given a   When b\nThen c ' };
    const r = evaluateDrift(approved, { acIds: Object.keys(reflowed), fingerprints: reFingerprint(reflowed) });
    expect(r.changed).toEqual([]);
    expect(r.status).toBe('approved');
  });
});
