import { describe, it, expect } from 'vitest';
import { checkDependsOn, checkSupersedes, lintAuthoring } from '../src/authoring/lint.js';

describe('checkDependsOn (system-ref shape)', () => {
  it('accepts context-segmented element ids and NFR', () => {
    expect(
      checkDependsOn(['DOM-scheduling-001', 'DATA-scheduling-014', 'CONTRACT-payments-002', 'NFR-007']).ok,
    ).toBe(true);
  });
  it('flags flat (non-context) ids and other malformed shapes', () => {
    const r = checkDependsOn(['DOM-001', 'DATA-scheduling', 'AC-FOO-001']);
    expect(r.ok).toBe(false);
    expect(r.malformed).toEqual(['DOM-001', 'DATA-scheduling', 'AC-FOO-001']);
  });
});

describe('checkSupersedes (fold edges)', () => {
  it('accepts a well-formed past AC-ID', () => {
    expect(checkSupersedes(['AC-OLDFEAT-003'], ['AC-NEWFEAT-001']).ok).toBe(true);
  });
  it('flags a malformed supersedes id', () => {
    expect(checkSupersedes(['DOM-scheduling-001'], ['AC-NEWFEAT-001']).malformed).toContain('DOM-scheduling-001');
  });
  it("flags superseding this spec's own AC", () => {
    const r = checkSupersedes(['AC-NEWFEAT-001'], ['AC-NEWFEAT-001']);
    expect(r.ok).toBe(false);
    expect(r.selfSuperseded).toContain('AC-NEWFEAT-001');
  });
});

describe('lintAuthoring wires dependsOn / supersedes', () => {
  const base = {
    specAcIds: ['AC-F-001'],
    acceptanceAcIds: ['AC-F-001'],
    methodsById: { 'AC-F-001': 'unit_test' },
  };
  it('passes when the optional fields are omitted (back-compat)', () => {
    expect(lintAuthoring(base).ok).toBe(true);
  });
  it('fails a spec with zero acceptance criteria (no vacuous pass)', () => {
    const r = lintAuthoring({ specAcIds: [], acceptanceAcIds: [], methodsById: {} });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('no acceptance criteria'))).toBe(true);
  });
  it('passes a clean dependsOn + supersedes', () => {
    const r = lintAuthoring({ ...base, dependsOn: ['DATA-scheduling-014'], supersedes: ['AC-OLD-002'] });
    expect(r.ok).toBe(true);
  });
  it('reports a malformed dependsOn id', () => {
    const r = lintAuthoring({ ...base, dependsOn: ['DOM-001'] });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('dependsOn'))).toBe(true);
  });
  it("reports superseding this spec's own AC", () => {
    const r = lintAuthoring({ ...base, supersedes: ['AC-F-001'] });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('supersede'))).toBe(true);
  });
});
