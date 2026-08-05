import { describe, it, expect } from 'vitest';
import { fingerprintAc } from '../src/authoring/fingerprint.js';
import { checkCoverage, checkNoReuse, checkManualAbsence, lintAuthoring } from '../src/authoring/lint.js';
import { resolve, serializeContract, type ResolvedSource } from '../src/resolve/resolve.js';

// --- shared fixture: Todo due-date, SLICE-001 (greenfield) ------------------

const AC = 'AC-TODODUE-001';

function approvedSource(): ResolvedSource {
  return {
    issueType: 'feature',
    narrative: { productGoal: '期限を保存・編集できる', userStory: '期限を設定したい（忘れないため）' },
    acceptanceCriteriaIds: [AC],
    behaviorById: { [AC]: 'Given 作成/編集画面 When 期限を入力して保存 Then 永続化され未入力は null' },
    verificationById: {
      [AC]: { severity: 'blocker', method: 'api_test', expected: ['POST→GET 往復', '省略時 null'] },
    },
    scope: { include: ['dueDate 永続化'], exclude: ['通知'] },
    redLines: ['既存 Todo を破壊しない'],
    techStack: ['typescript'],
    sliceCoversAcIds: [AC],
  };
}

/** acFingerprints as pinned at sign time, matching the approved source. */
function approvedFingerprints(src: ResolvedSource): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of src.acceptanceCriteriaIds) {
    const v = src.verificationById[id];
    const behavior = src.behaviorById[id];
    if (!v || behavior === undefined) continue; // skip ids without content (used by the "missing" test)
    out[id] = fingerprintAc({ behavior, severity: v.severity, method: v.method, expected: v.expected });
  }
  return out;
}

// --- fingerprint -------------------------------------------------------------

describe('fingerprintAc', () => {
  const base = { behavior: 'Given a When b Then c', severity: 'blocker', method: 'api_test', expected: ['x', 'y'] };

  it('is stable for identical input', () => {
    expect(fingerprintAc(base)).toBe(fingerprintAc({ ...base }));
  });

  it('ignores cosmetic whitespace', () => {
    expect(fingerprintAc(base)).toBe(fingerprintAc({ ...base, behavior: '  Given a   When b\nThen c ' }));
  });

  it('changes when severity / method / expected / behavior change', () => {
    expect(fingerprintAc({ ...base, severity: 'major' })).not.toBe(fingerprintAc(base));
    expect(fingerprintAc({ ...base, method: 'unit_test' })).not.toBe(fingerprintAc(base));
    expect(fingerprintAc({ ...base, expected: ['x'] })).not.toBe(fingerprintAc(base));
    expect(fingerprintAc({ ...base, behavior: 'Given a When b Then DIFFERENT' })).not.toBe(fingerprintAc(base));
  });
});

// --- lint --------------------------------------------------------------------

describe('authoring lint', () => {
  it('coverage is bidirectional', () => {
    expect(checkCoverage(['A', 'B'], ['A', 'B']).ok).toBe(true);
    const r = checkCoverage(['A', 'B'], ['A', 'C']);
    expect(r.ok).toBe(false);
    expect(r.missingInAcceptance).toEqual(['B']);
    expect(r.missingInSpec).toEqual(['C']);
  });

  it('catches duplicate AC-IDs', () => {
    expect(checkNoReuse(['A', 'B']).ok).toBe(true);
    expect(checkNoReuse(['A', 'A', 'B', 'B']).duplicates.sort()).toEqual(['A', 'B']);
  });

  it('rejects manual methods in acceptance.yaml', () => {
    expect(checkManualAbsence({ A: 'api_test' }).ok).toBe(true);
    expect(checkManualAbsence({ A: 'api_test', B: 'manual' }).manualAcIds).toEqual(['B']);
  });

  it('combined lint reports all errors', () => {
    const r = lintAuthoring({ specAcIds: ['A', 'A', 'B'], acceptanceAcIds: ['A', 'C'], methodsById: { A: 'manual', C: 'unit_test' } });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3); // coverage(both ways) + dup + manual
  });
});

// --- resolve -----------------------------------------------------------------

describe('resolve (M05)', () => {
  it('resolves an approved greenfield source into a valid contract', () => {
    const src = approvedSource();
    const r = resolve(src, approvedFingerprints(src));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contract.acceptanceCriteria).toHaveLength(1);
    const ac = r.contract.acceptanceCriteria[0]!;
    expect(ac.id).toBe(AC);
    expect(ac.severity).toBe('blocker'); // from acceptance.yaml
    expect(ac.behavior).toContain('期限を入力'); // from spec.md
    expect(r.contract.tech_stack).toEqual(['typescript']);
  });

  it('is deterministic (byte-identical across runs)', () => {
    const src = approvedSource();
    const fp = approvedFingerprints(src);
    const a = resolve(src, fp);
    const b = resolve(src, fp);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(serializeContract(a.contract)).toBe(serializeContract(b.contract));
  });

  it('blocks on drift (acFingerprints mismatch)', () => {
    const src = approvedSource();
    const r = resolve(src, {}); // no approved fingerprints -> all drift
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: 'drift', acIds: [AC] });
  });

  it('blocks when behavior changed after signing', () => {
    const src = approvedSource();
    const fp = approvedFingerprints(src);
    src.behaviorById[AC] = 'Given X When Y Then CHANGED';
    const r = resolve(src, fp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('drift');
  });

  it('rejects a manual method', () => {
    const src = approvedSource();
    src.verificationById[AC] = { severity: 'blocker', method: 'manual', expected: ['x'] };
    const r = resolve(src, approvedFingerprints(src));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: 'manual', acIds: [AC] });
  });

  it('rejects three-way coverage mismatch (slice vs source)', () => {
    const src = approvedSource();
    src.sliceCoversAcIds = ['AC-TODODUE-999'];
    const r = resolve(src, approvedFingerprints(src));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('coverage');
  });

  it('rejects a missing behavior/verification', () => {
    const src = approvedSource();
    src.acceptanceCriteriaIds = [AC, 'AC-TODODUE-002'];
    src.sliceCoversAcIds = [AC, 'AC-TODODUE-002'];
    const r = resolve(src, approvedFingerprints(src));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: 'missing', acIds: ['AC-TODODUE-002'] });
  });

  it('rejects an invalid severity via schema validation', () => {
    const src = approvedSource();
    src.verificationById[AC] = { severity: 'critical', method: 'api_test', expected: ['x'] };
    const r = resolve(src, approvedFingerprints(src)); // fingerprints match the bad severity, so drift passes
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('schema');
  });

  it('resolves a targeted source with no slice and no tech_stack', () => {
    const src = approvedSource();
    delete src.sliceCoversAcIds;
    delete src.techStack;
    const r = resolve(src, approvedFingerprints(src));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.contract.tech_stack).toBeUndefined();
  });
});
