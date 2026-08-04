/**
 * ISSUE-0004 — repair briefs forward the FULL fix list. buildPanelRepairBrief used to keep
 * only requiredFix[0] per criterion, so a reviewer's multi-step fix arrived truncated at the
 * generator. These tests pin the fidelity guarantee (AC-1) and the unchanged blocker-first /
 * attribution policy (AC-2) of the panel repair path.
 */
import { describe, it, expect } from 'vitest';
import { buildPanelRepairBrief, buildRepairBrief, toGenerateBrief } from '../src/pipeline/repair.js';
import { EvalRun, Finding } from '../src/domain/schema.js';

function run(id: string, perspective: string, findings: Finding[]): EvalRun {
  return EvalRun.parse({
    id, issueId: 'ISSUE-X', prId: 'PR-1', attempt: 1, sampleIndex: 0, agent: 'claude',
    verdict: 'request_changes', findings, perspective,
    scores: { functionality: 0, codeQuality: 0, testQuality: 0, ux: 0, accessibility: 0 },
    overall: 0.4, cost: {}, createdAt: '2026-01-01T00:00:00.000Z',
  });
}

function finding(criterionId: string, severity: Finding['severity'], requiredFix: string[]): Finding {
  return Finding.parse({ criterionId, severity, expected: 'e', observed: 'o', requiredFix });
}

describe('panel repair brief forwards the full fix list (ISSUE-0004)', () => {
  it('AC-1 forwards every requiredFix line of a finding to the generator brief, in order', () => {
    const fixes = ['fix the parser', 'add the boundary test', 'document the strictness'];
    const brief = toGenerateBrief(buildPanelRepairBrief([run('EVAL-1', 'testQuality', [finding('AC-9', 'blocker', fixes)])]));
    expect(brief.instructions).toEqual(fixes);
  });

  it('AC-1 preserves order within each criterion when several criteria are forwarded', () => {
    const brief = toGenerateBrief(
      buildPanelRepairBrief([
        run('EVAL-1', 'testQuality', [
          finding('AC-1', 'major', ['a-first', 'a-second']),
          finding('AC-2', 'major', ['b-first', 'b-second']),
        ]),
      ]),
    );
    for (const [first, second] of [['a-first', 'a-second'], ['b-first', 'b-second']] as const) {
      expect(brief.instructions.indexOf(first)).toBeGreaterThanOrEqual(0);
      expect(brief.instructions.indexOf(first)).toBeLessThan(brief.instructions.indexOf(second));
    }
  });

  it('AC-1 panel path is as faithful as the single-run brief for the same finding', () => {
    const fixes = ['step one', 'step two', 'step three'];
    const single = run('EVAL-1', 'testQuality', [finding('AC-9', 'blocker', fixes)]);
    expect(toGenerateBrief(buildPanelRepairBrief([single])).instructions).toEqual(
      buildRepairBrief(single).instructions,
    );
  });

  it('AC-2 blocker-first forwarding and per-criterion perspective attribution are unchanged', () => {
    const panel = buildPanelRepairBrief([
      run('EVAL-1', 'testQuality', [finding('AC-9', 'blocker', ['only fix']), finding('AC-8', 'minor', ['cosmetic'])]),
      run('EVAL-2', 'codeQuality', [finding('AC-9', 'blocker', ['only fix'])]),
    ]);
    // blocker-first: the minor AC-8 is suppressed while a blocker exists
    expect(panel.instructions.every((i) => i.criterionId === 'AC-9')).toBe(true);
    expect(panel.findings.every((f) => f.severity === 'blocker')).toBe(true);
    // one instruction group per distinct finding (identical content merges), every lens named
    expect(panel.instructions).toHaveLength(1);
    expect(panel.instructions[0]!.perspectives).toEqual(['codeQuality', 'testQuality']);
  });

  it('AC-2 upgrades a content-identical finding to its most severe instance (ISSUE-0016: identity is content, not criterionId)', () => {
    // The major instance arrives FIRST, so only the merge's severity upgrade can promote the
    // group when the blocker instance arrives later. Same requiredFix list = same finding.
    const panel = buildPanelRepairBrief([
      run('EVAL-1', 'codeQuality', [finding('AC-9', 'major', ['b1', 'b2'])]),
      run('EVAL-2', 'security', [finding('AC-9', 'blocker', ['b1', 'b2'])]),
      run('EVAL-3', 'testQuality', [finding('AC-8', 'minor', ['cosmetic'])]),
    ]);
    // the merged instruction carries the blocker severity and the shared fix list
    expect(panel.instructions).toHaveLength(1);
    expect(panel.instructions[0]!.criterionId).toBe('AC-9');
    expect(panel.instructions[0]!.severity).toBe('blocker');
    expect(panel.instructions[0]!.instructions).toEqual(['b1', 'b2']);
    // blocker-first suppression keys off the upgraded severity: the minor AC-8 is dropped
    expect(panel.findings).toHaveLength(1);
    expect(panel.findings[0]!.severity).toBe('blocker');
    expect(panel.findings[0]!.requiredFix).toEqual(['b1', 'b2']);
    // attribution names every lens that raised this finding
    expect(panel.instructions[0]!.perspectives).toEqual(['codeQuality', 'security']);
  });

  it('AC-2 a same-criterion sibling with DIFFERENT content is a different finding: blocker-first suppresses it, never merges it (ISSUE-0016)', () => {
    const panel = buildPanelRepairBrief([
      run('EVAL-1', 'codeQuality', [finding('AC-9', 'major', ['m1', 'm2'])]),
      run('EVAL-2', 'security', [finding('AC-9', 'blocker', ['b1', 'b2'])]),
    ]);
    // only the blocker finding forwards this round, with ITS fixes and ITS lens
    expect(panel.instructions).toHaveLength(1);
    expect(panel.instructions[0]!.severity).toBe('blocker');
    expect(panel.instructions[0]!.instructions).toEqual(['b1', 'b2']);
    expect(panel.instructions[0]!.perspectives).toEqual(['security']);
  });

  it('AC-2 a finding with no requiredFix still yields the Resolve fallback', () => {
    const brief = toGenerateBrief(buildPanelRepairBrief([run('EVAL-1', 'security', [finding('AC-7', 'major', [])])]));
    expect(brief.instructions).toEqual(['Resolve AC-7']);
  });

  it('routes separate-issue findings out of the current-branch repair brief', () => {
    const inChange = Finding.parse({
      ...finding('AC-current', 'major', ['fix the current contract']),
      disposition: 'in-change',
    });
    const separate = Finding.parse({
      ...finding('AC-child', 'major', ['implement isolated child scope']),
      disposition: 'separate-issue',
      separationReason: 'This is independently testable adjacent scope.',
    });
    const brief = buildPanelRepairBrief([
      run('EVAL-split', 'codeQuality', [inChange, separate]),
    ]);
    expect(brief.findings.map((candidate) => candidate.criterionId))
      .toEqual(['AC-current']);
    expect(brief.instructions.flatMap((instruction) => instruction.instructions))
      .toEqual(['fix the current contract']);
  });
});
