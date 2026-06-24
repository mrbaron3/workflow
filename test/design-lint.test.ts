import { describe, it, expect } from 'vitest';
import {
  lintDesign,
  checkAcCoverage,
  checkSliceDag,
  checkAdditive,
  checkReferencesPresent,
  type SliceCore,
} from '../src/design/lint.js';

// The Todo-due example from loop1-walkthrough §4: two slices, AC-001 / {002,003}.
const todoDueSlices: SliceCore[] = [
  { sliceId: 'SLICE-TODODUE-001', coversAcIds: ['AC-TODODUE-001'], dependsOnSlices: [], dependsOnSystem: ['DATA-014'] },
  {
    sliceId: 'SLICE-TODODUE-002',
    coversAcIds: ['AC-TODODUE-002', 'AC-TODODUE-003'],
    dependsOnSlices: ['SLICE-TODODUE-001'],
    dependsOnSystem: ['DATA-014', 'ARCH-031'],
  },
];
const todoDueAcIds = ['AC-TODODUE-001', 'AC-TODODUE-002', 'AC-TODODUE-003'];
const systemIds = ['DATA-014', 'ARCH-031'];

describe('design lint — happy path (loop1-walkthrough Todo-due)', () => {
  it('passes coverage + DAG + refs', () => {
    const r = lintDesign({ specAcIds: todoDueAcIds, slices: todoDueSlices, systemElementIds: systemIds });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe('coverage & exclusivity (bidirectional)', () => {
  it('flags an uncovered AC', () => {
    const r = checkAcCoverage([...todoDueAcIds, 'AC-TODODUE-004'], todoDueSlices);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('AC-TODODUE-004');
  });

  it('flags an AC covered by two slices', () => {
    const dup: SliceCore[] = [
      { sliceId: 'S1', coversAcIds: ['AC-TODODUE-001'], dependsOnSlices: [], dependsOnSystem: [] },
      { sliceId: 'S2', coversAcIds: ['AC-TODODUE-001'], dependsOnSlices: [], dependsOnSystem: [] },
    ];
    expect(checkAcCoverage(['AC-TODODUE-001'], dup).duplicated).toContain('AC-TODODUE-001');
  });
});

describe('dependency DAG', () => {
  it('detects a cycle', () => {
    const cyclic: SliceCore[] = [
      { sliceId: 'A', coversAcIds: [], dependsOnSlices: ['B'], dependsOnSystem: [] },
      { sliceId: 'B', coversAcIds: [], dependsOnSlices: ['A'], dependsOnSystem: [] },
    ];
    const r = checkSliceDag(cyclic);
    expect(r.ok).toBe(false);
    expect(r.cycle.length).toBeGreaterThan(0);
  });

  it('detects a dangling slice reference', () => {
    const r = checkSliceDag([{ sliceId: 'A', coversAcIds: [], dependsOnSlices: ['ghost'], dependsOnSystem: [] }]);
    expect(r.unknownRefs).toContain('ghost');
  });
});

describe('system-layer additive-only', () => {
  it('rejects a delta that reuses an existing element id', () => {
    expect(checkAdditive(['DATA-014'], ['DATA-014']).ok).toBe(false);
  });
  it('accepts a delta that only adds new ids', () => {
    expect(checkAdditive(['DATA-014'], ['DATA-015']).ok).toBe(true);
  });
});

describe('reference existence (system tier — used by to-system-design)', () => {
  it('passes when every referenced id is present', () => {
    expect(checkReferencesPresent(['DATA-014', 'ARCH-031'], ['DATA-014', 'ARCH-031', 'DOM-001']).ok).toBe(true);
  });
  it('flags a delta referencing an absent element', () => {
    const r = checkReferencesPresent(['DATA-014', 'DATA-099'], ['DATA-014']);
    expect(r.ok).toBe(false);
    expect(r.dangling).toContain('DATA-099');
  });
});

describe('dangling system reference', () => {
  it('flags a slice referencing a non-existent system element', () => {
    const r = lintDesign({
      specAcIds: ['AC-X-001'],
      slices: [{ sliceId: 'S1', coversAcIds: ['AC-X-001'], dependsOnSlices: [], dependsOnSystem: ['DATA-999'] }],
      systemElementIds: ['DATA-014'],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('DATA-999'))).toBe(true);
  });
});
