import { describe, it, expect } from 'vitest';
import {
  lintDesign,
  checkAcCoverage,
  checkIssueDag,
  checkAdditive,
  checkReferencesPresent,
  type IssueCore,
} from '../src/design/lint.js';

// The Todo-due example from loop1-walkthrough §4: two issues, AC-001 / {002,003}.
const todoDueIssues: IssueCore[] = [
  { key: 'ISSUE-TODODUE-001', coversAcIds: ['AC-TODODUE-001'], dependsOnIssues: [], dependsOnSystem: ['DATA-scheduling-014'] },
  {
    key: 'ISSUE-TODODUE-002',
    coversAcIds: ['AC-TODODUE-002', 'AC-TODODUE-003'],
    dependsOnIssues: ['ISSUE-TODODUE-001'],
    dependsOnSystem: ['DATA-scheduling-014', 'ARCH-scheduling-031'],
  },
];
const todoDueAcIds = ['AC-TODODUE-001', 'AC-TODODUE-002', 'AC-TODODUE-003'];
const systemIds = ['DATA-scheduling-014', 'ARCH-scheduling-031'];

describe('design lint — happy path (loop1-walkthrough Todo-due)', () => {
  it('passes coverage + DAG + refs', () => {
    const r = lintDesign({ specAcIds: todoDueAcIds, issues: todoDueIssues, systemElementIds: systemIds });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe('coverage & exclusivity (bidirectional)', () => {
  it('flags an uncovered AC', () => {
    const r = checkAcCoverage([...todoDueAcIds, 'AC-TODODUE-004'], todoDueIssues);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('AC-TODODUE-004');
  });

  it('flags an AC covered by two issues', () => {
    const dup: IssueCore[] = [
      { key: 'I1', coversAcIds: ['AC-TODODUE-001'], dependsOnIssues: [], dependsOnSystem: [] },
      { key: 'I2', coversAcIds: ['AC-TODODUE-001'], dependsOnIssues: [], dependsOnSystem: [] },
    ];
    expect(checkAcCoverage(['AC-TODODUE-001'], dup).duplicated).toContain('AC-TODODUE-001');
  });
});

describe('dependency DAG', () => {
  it('detects a cycle', () => {
    const cyclic: IssueCore[] = [
      { key: 'A', coversAcIds: [], dependsOnIssues: ['B'], dependsOnSystem: [] },
      { key: 'B', coversAcIds: [], dependsOnIssues: ['A'], dependsOnSystem: [] },
    ];
    const r = checkIssueDag(cyclic);
    expect(r.ok).toBe(false);
    expect(r.cycle.length).toBeGreaterThan(0);
  });

  it('detects a dangling issue reference', () => {
    const r = checkIssueDag([{ key: 'A', coversAcIds: [], dependsOnIssues: ['ghost'], dependsOnSystem: [] }]);
    expect(r.unknownRefs).toContain('ghost');
  });
});

describe('system-layer additive-only', () => {
  it('rejects a delta that reuses an existing element id', () => {
    expect(checkAdditive(['DATA-scheduling-014'], ['DATA-scheduling-014']).ok).toBe(false);
  });
  it('accepts a delta that only adds new ids', () => {
    expect(checkAdditive(['DATA-scheduling-014'], ['DATA-scheduling-015']).ok).toBe(true);
  });
});

describe('reference existence (system tier — used by to-system-design)', () => {
  it('passes when every referenced id is present', () => {
    expect(
      checkReferencesPresent(
        ['DATA-scheduling-014', 'ARCH-scheduling-031'],
        ['DATA-scheduling-014', 'ARCH-scheduling-031', 'DOM-scheduling-001'],
      ).ok,
    ).toBe(true);
  });
  it('flags a delta referencing an absent element', () => {
    const r = checkReferencesPresent(['DATA-scheduling-014', 'DATA-scheduling-099'], ['DATA-scheduling-014']);
    expect(r.ok).toBe(false);
    expect(r.dangling).toContain('DATA-scheduling-099');
  });
});

describe('dangling system reference', () => {
  it('flags an issue referencing a non-existent system element', () => {
    const r = lintDesign({
      specAcIds: ['AC-X-001'],
      issues: [{ key: 'I1', coversAcIds: ['AC-X-001'], dependsOnIssues: [], dependsOnSystem: ['DATA-scheduling-999'] }],
      systemElementIds: ['DATA-scheduling-014'],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('DATA-scheduling-999'))).toBe(true);
  });
});
