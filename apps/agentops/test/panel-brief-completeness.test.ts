/**
 * ISSUE-0016 — the panel repair brief carries EVERY finding. buildPanelRepairBrief used to
 * keep only the most-severe finding per criterionId, so same-criterion sibling findings
 * (distinct content, distinct requiredFix) were silently dropped: the generator was blamed
 * for "not landing" fixes it never saw. criterionId is NOT finding identity (ISSUE-0009
 * established that for lineage); the only permissible collapse is CONTENT identity
 * (criterionId + requiredFix list), which merges perspectives.
 */
import { describe, it, expect } from 'vitest';
import { buildPanelRepairBrief, toGenerateBrief } from '../src/pipeline/repair.js';
import { EvalRun, Finding } from '../src/domain/schema.js';

function run(id: string, perspective: string, findings: Finding[]): EvalRun {
  return EvalRun.parse({
    id, issueId: 'ISSUE-X', prId: 'PR-1', attempt: 1, sampleIndex: 0, agent: 'claude',
    verdict: 'request_changes', findings, perspective,
    scores: { functionality: 0, codeQuality: 0, testQuality: 0, ux: 0, accessibility: 0 },
    overall: 0.4, cost: {}, createdAt: '2026-01-01T00:00:00.000Z',
  });
}

function finding(criterionId: string, severity: Finding['severity'], requiredFix: string[], observed = 'o'): Finding {
  return Finding.parse({ criterionId, severity, expected: 'e', observed, requiredFix });
}

describe('panel repair brief carries every finding (ISSUE-0016)', () => {
  it('ISSUE-0016/AC-BRIEF-001 three distinct same-criterion findings from one lens all reach the brief, severity-ordered', () => {
    const siblings = [
      finding('AC-X', 'minor', ['extract the id helper', 'unify the id shape'], 'id convention duplicated'),
      finding('AC-X', 'major', ['consolidate the predicate', 'replace the inline spellings'], 'predicate spelled ad hoc'),
      finding('AC-X', 'minor', ['add the store mutation', 'route the retire through it'], 'store poked directly'),
    ];
    const brief = toGenerateBrief(buildPanelRepairBrief([run('EVAL-1', 'codeQuality', siblings)]));
    // instruction total = sum of requiredFix lines over ALL forwarded findings — nothing dropped
    expect(brief.instructions).toHaveLength(6);
    const text = brief.instructions.join('\n');
    for (const f of siblings) for (const fix of f.requiredFix) expect(text).toContain(fix);
    // severity order: the major finding's fixes precede both minors'
    expect(text.indexOf('consolidate the predicate')).toBeLessThan(text.indexOf('extract the id helper'));
    expect(text.indexOf('consolidate the predicate')).toBeLessThan(text.indexOf('add the store mutation'));
  });

  it('ISSUE-0016/AC-BRIEF-001 same-criterion findings from two lenses both arrive (no most-severe eclipse)', () => {
    const brief = toGenerateBrief(
      buildPanelRepairBrief([
        run('EVAL-1', 'codeQuality', [finding('AC-Y', 'minor', ['make the instruments required'], 'optional in the type')]),
        run('EVAL-2', 'testQuality', [finding('AC-Y', 'major', ['assert the ratio over total records'], 'ratio tested against distinct issues')]),
      ]),
    );
    const text = brief.instructions.join('\n');
    expect(text).toContain('make the instruments required');
    expect(text).toContain('assert the ratio over total records');
  });

  it('ISSUE-0016/AC-BRIEF-001 a forwarded finding with no requiredFix contributes exactly the one Resolve fallback line', () => {
    const brief = toGenerateBrief(
      buildPanelRepairBrief([
        run('EVAL-1', 'security', [finding('AC-X', 'major', [], 'problem A'), finding('AC-X', 'major', ['fix B'], 'problem B')]),
      ]),
    );
    expect(brief.instructions).toHaveLength(2);
    expect(brief.instructions).toContain('Resolve AC-X');
    expect(brief.instructions).toContain('fix B');
  });

  it('ISSUE-0016/AC-BRIEF-002 blocker-first forwards ALL blocker findings, not one representative per criterion', () => {
    const panel = buildPanelRepairBrief([
      run('EVAL-1', 'functionality', [
        finding('AC-X', 'blocker', ['fix the parser'], 'parser rejects valid input'),
        finding('AC-X', 'blocker', ['fix the serializer'], 'serializer emits garbage'),
        finding('AC-Y', 'major', ['tidy the naming'], 'mixed vocabulary'),
      ]),
    ]);
    const text = toGenerateBrief(panel).instructions.join('\n');
    expect(text).toContain('fix the parser');
    expect(text).toContain('fix the serializer'); // the sibling blocker is not eclipsed
    expect(text).not.toContain('tidy the naming'); // blocker-first policy unchanged
    expect(panel.findings.every((f) => f.severity === 'blocker')).toBe(true);
  });

  it('ISSUE-0016/AC-BRIEF-002 attribution stays auditable per forwarded finding: own criterionId, severity and lenses', () => {
    const panel = buildPanelRepairBrief([
      run('EVAL-1', 'codeQuality', [finding('AC-X', 'major', ['fix A'], 'problem A')]),
      run('EVAL-2', 'testQuality', [finding('AC-X', 'minor', ['fix B'], 'problem B')]),
    ]);
    const entries = panel.instructions.filter((i) => i.criterionId === 'AC-X');
    expect(entries).toHaveLength(2); // one auditable group per distinct finding
    const bySeverity = new Map(entries.map((e) => [e.severity, e]));
    expect(bySeverity.get('major')!.perspectives).toEqual(['codeQuality']);
    expect(bySeverity.get('minor')!.perspectives).toEqual(['testQuality']);
  });

  it('ISSUE-0016/AC-BRIEF-002 ISSUE-0004 fidelity is untouched: full requiredFix list of each finding, order preserved', () => {
    const brief = toGenerateBrief(
      buildPanelRepairBrief([run('EVAL-1', 'testQuality', [finding('AC-Z', 'major', ['first', 'second', 'third'])])]),
    );
    expect(brief.instructions).toEqual(['first', 'second', 'third']);
  });

  it('ISSUE-0016/AC-BRIEF-003 identical content from two lenses merges into one group with the perspectives unioned', () => {
    const panel = buildPanelRepairBrief([
      run('EVAL-1', 'codeQuality', [finding('AC-Z', 'blocker', ['the one fix', 'its follow-up'])]),
      run('EVAL-2', 'testQuality', [finding('AC-Z', 'blocker', ['the one fix', 'its follow-up'])]),
    ]);
    const entries = panel.instructions.filter((i) => i.criterionId === 'AC-Z');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.perspectives).toEqual(['codeQuality', 'testQuality']);
    // merged, not duplicated
    expect(toGenerateBrief(panel).instructions).toEqual(['the one fix', 'its follow-up']);
  });

  it('ISSUE-0016/AC-BRIEF-003 same criterionId with different requiredFix lists never collapses', () => {
    const panel = buildPanelRepairBrief([
      run('EVAL-1', 'codeQuality', [finding('AC-W', 'major', ['fix via route A'])]),
      run('EVAL-2', 'testQuality', [finding('AC-W', 'major', ['fix via route B'])]),
    ]);
    expect(panel.instructions.filter((i) => i.criterionId === 'AC-W')).toHaveLength(2);
    const text = toGenerateBrief(panel).instructions.join('\n');
    expect(text).toContain('fix via route A');
    expect(text).toContain('fix via route B');
  });

  it('ISSUE-0016/AC-BRIEF-003 different criterionIds with identical requiredFix lists never merge', () => {
    const sharedFix = ['align the copy with the schema', 'add the guard clause'];
    const panel = buildPanelRepairBrief([
      run('EVAL-1', 'codeQuality', [finding('AC-P', 'major', [...sharedFix])]),
      run('EVAL-2', 'testQuality', [finding('AC-Q', 'major', [...sharedFix])]),
    ]);
    // content identity is criterionId AND requiredFix — a shared fix list alone never collapses
    expect(panel.instructions).toHaveLength(2);
    const p = panel.instructions.filter((i) => i.criterionId === 'AC-P');
    const q = panel.instructions.filter((i) => i.criterionId === 'AC-Q');
    expect(p).toHaveLength(1);
    expect(q).toHaveLength(1);
    expect(p[0]!.perspectives).toEqual(['codeQuality']);
    expect(q[0]!.perspectives).toEqual(['testQuality']);
    expect(p[0]!.instructions).toEqual(sharedFix);
    expect(q[0]!.instructions).toEqual(sharedFix);
    // instruction total = sum of both findings' requiredFix lines — no cross-criterion dedup
    expect(toGenerateBrief(panel).instructions).toHaveLength(4);
  });
});
