/**
 * Env-gated acceptance grader for ISSUE-0016 "panel repair brief carries EVERY finding" —
 * contract scripts/seeds/panel-brief-completeness.contract.yaml (AC-BRIEF-001..003), adopted
 * from the Analyst's R1 proposal with the attached draft REPLACED by grounded evidence.
 *
 * The evidence (⑪, PromptRecord audit of the ⑨⑩ repair rounds): of the 7 findings the
 * reviewers attested as `persisted`, FIVE were never in the brief at all —
 * buildPanelRepairBrief keeps only the most-severe finding per criterionId, silently
 * dropping same-criterion sibling findings (distinct content, distinct requiredFix). The
 * generator was blamed for "not landing" fixes it never saw, repairSuccess read falsely
 * low, and every conditional approval since ⑥ carried pins the loop should have landed
 * itself. criterionId is NOT finding identity — ISSUE-0009 established that for lineage;
 * this closes the same defect class in the repair merge.
 *
 * Red at baseline BY DESIGN, collected only under ACCEPT_HARNESS=1 (ADR-0007 I3). After the
 * build is human-approved and released, the skipIf is dropped and this file stays in
 * protectedPaths as the permanent regression guard.
 *
 * Semantics this file pins:
 *   - Every distinct panel finding is forwarded with its FULL requiredFix (severity-ordered);
 *     the instruction total equals the sum over forwarded findings (Resolve fallback = 1).
 *   - Blocker-first survives, but as a FINDING filter, not a criterion-representative pick:
 *     when blockers exist, ALL blocker findings forward (including same-criterion siblings).
 *   - The only permissible collapse is CONTENT identity (criterionId + requiredFix list),
 *     merging perspectives — never criterionId coincidence.
 *   - Attribution stays auditable per forwarded finding (criterionId / severity / lenses).
 */
import { describe, it, expect } from 'vitest';
import { buildPanelRepairBrief, toGenerateBrief } from '../../src/pipeline/repair.js';
import { EvalRun, Finding } from '../../src/domain/schema.js';

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

describe.skipIf(!process.env.ACCEPT_HARNESS)('panel repair brief carries every finding (ISSUE-0016)', () => {
  it('ISSUE-0016/AC-BRIEF-001 same-criterion sibling findings from ONE lens all reach the brief — the ⑩ shape (3 distinct AC-LIFE-002 findings) loses nothing', () => {
    // The grounded ⑩ failure shape: codeQuality raised three DIFFERENT problems on one AC.
    const siblings = [
      finding('AC-X', 'major', ['consolidate the predicate', 'replace the four inline spellings'], 'predicate spelled ad hoc'),
      finding('AC-X', 'minor', ['add Store.updateEvalTask', 'route the retire mutation through it'], 'store record poked directly'),
      finding('AC-X', 'minor', ['extract buildTaskId/parseTaskId', 'unify the issue-id shape'], 'id convention encoded four times'),
    ];
    const brief = toGenerateBrief(buildPanelRepairBrief([run('EVAL-1', 'codeQuality', siblings)]));
    const text = brief.instructions.join('\n');
    for (const f of siblings) for (const fix of f.requiredFix) expect(text).toContain(fix);
    expect(brief.instructions).toHaveLength(6); // sum over findings — nothing dropped, nothing duplicated
    // severity order: the major finding's fixes come before the minors'
    expect(text.indexOf('consolidate the predicate')).toBeLessThan(text.indexOf('add Store.updateEvalTask'));
  });

  it('ISSUE-0016/AC-BRIEF-001 same-criterion findings from TWO lenses both arrive — the ⑨ shape (optional-type minor eclipsed by a same-AC major) loses nothing', () => {
    const codeQuality = finding('AC-Y', 'minor', ['make the instruments required `number | null`'], 'optional in the Metrics type');
    const testQuality = finding('AC-Y', 'major', ['assert the ratio over TOTAL records'], 'ratio tested against distinct issues');
    const brief = toGenerateBrief(buildPanelRepairBrief([
      run('EVAL-1', 'codeQuality', [codeQuality]),
      run('EVAL-2', 'testQuality', [testQuality]),
    ]));
    const text = brief.instructions.join('\n');
    expect(text).toContain('make the instruments required'); // the ⑨ dropped fix
    expect(text).toContain('assert the ratio over TOTAL records');
  });

  it('ISSUE-0016/AC-BRIEF-002 blocker-first filters FINDINGS, not criterion representatives: sibling blockers both forward, non-blockers stay suppressed', () => {
    const panel = buildPanelRepairBrief([
      run('EVAL-1', 'functionality', [
        finding('AC-X', 'blocker', ['fix the parser'], 'parser rejects valid input'),
        finding('AC-X', 'blocker', ['fix the serializer'], 'serializer emits garbage'),
        finding('AC-Y', 'major', ['tidy the naming'], 'mixed vocabulary'),
      ]),
    ]);
    const text = toGenerateBrief(panel).instructions.join('\n');
    expect(text).toContain('fix the parser');
    expect(text).toContain('fix the serializer'); // the sibling blocker must not be eclipsed
    expect(text).not.toContain('tidy the naming'); // blocker-first policy unchanged
  });

  it('ISSUE-0016/AC-BRIEF-002 attribution is auditable per forwarded finding: two distinct same-criterion findings keep their own severity and lenses', () => {
    const panel = buildPanelRepairBrief([
      run('EVAL-1', 'codeQuality', [finding('AC-X', 'major', ['fix A'], 'problem A')]),
      run('EVAL-2', 'testQuality', [finding('AC-X', 'minor', ['fix B'], 'problem B')]),
    ]);
    const entries = panel.instructions.filter((i) => i.criterionId === 'AC-X');
    expect(entries).toHaveLength(2); // one auditable group per distinct finding
    const bySeverity = new Map(entries.map((e) => [e.severity, e]));
    expect(bySeverity.get('major')!.perspectives).toEqual(['codeQuality']);
    expect(bySeverity.get('minor')!.perspectives).toEqual(['testQuality']);
    // ISSUE-0004 fidelity within a finding is untouched: full list, in order.
    const ordered = buildPanelRepairBrief([
      run('EVAL-3', 'testQuality', [finding('AC-Z', 'major', ['first', 'second', 'third'])]),
    ]);
    const zText = toGenerateBrief(ordered).instructions.join('\n');
    expect(zText.indexOf('first')).toBeLessThan(zText.indexOf('second'));
    expect(zText.indexOf('second')).toBeLessThan(zText.indexOf('third'));
  });

  it('ISSUE-0016/AC-BRIEF-003 the only permissible collapse is content identity: identical findings merge (perspectives union), different content never does', () => {
    // Two lenses raise the SAME fix list on the same criterion → one group, both lenses named.
    const identical = buildPanelRepairBrief([
      run('EVAL-1', 'codeQuality', [finding('AC-Z', 'blocker', ['the one fix', 'its follow-up'])]),
      run('EVAL-2', 'testQuality', [finding('AC-Z', 'blocker', ['the one fix', 'its follow-up'])]),
    ]);
    const zEntries = identical.instructions.filter((i) => i.criterionId === 'AC-Z');
    expect(zEntries).toHaveLength(1);
    expect(zEntries[0]!.perspectives).toEqual(['codeQuality', 'testQuality']);
    const zInstr = toGenerateBrief(identical).instructions.filter((l) => l === 'the one fix');
    expect(zInstr).toHaveLength(1); // merged, not duplicated

    // Same criterion, different requiredFix → both survive as separate groups.
    const different = buildPanelRepairBrief([
      run('EVAL-3', 'codeQuality', [finding('AC-W', 'major', ['fix via route A'])]),
      run('EVAL-4', 'testQuality', [finding('AC-W', 'major', ['fix via route B'])]),
    ]);
    const wText = toGenerateBrief(different).instructions.join('\n');
    expect(wText).toContain('fix via route A');
    expect(wText).toContain('fix via route B');
  });
});
