/**
 * HARNESS-OWNED acceptance suite for the self-hosted improvement issue ISSUE-0004
 * "repair briefs forward the FULL fix list" (Analyst R1's failure class: a finding's
 * requiredFix[1..] never reach the generator — buildPanelRepairBrief keeps only
 * requiredFix[0] per criterion, so a multi-step fix arrives truncated and the repair
 * attempt cannot land it).
 *
 * env-gate convention (ADR-0007 I3): collected ONLY when ACCEPT_HARNESS=1 — AC-1 is red
 * at baseline BY DESIGN; the ordinary `npm test` must not see it. The execution layer's
 * grader runs with the env set (scripts/real-run-self.ts), making this the independent
 * grader the agent must satisfy but may not edit (config.target.protectedPaths). Once the
 * fix is released, drop the skipIf to promote it into the permanent regression suite.
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

function finding(criterionId: string, severity: Finding['severity'], requiredFix: string[]): Finding {
  return Finding.parse({ criterionId, severity, expected: 'e', observed: 'o', requiredFix });
}

describe.skipIf(!process.env.ACCEPT_HARNESS)('repair briefs forward the full fix list', () => {
  it('AC-1 every requiredFix line of a forwarded finding reaches the generator brief, in order', () => {
    const fixes = ['Fix the parser rejection table', 'Add the boundary test for 3999', 'Document the strictness in the JSDoc'];
    const brief = toGenerateBrief(buildPanelRepairBrief([run('EVAL-1', 'testQuality', [finding('AC-9', 'blocker', fixes)])]));
    const text = brief.instructions.join('\n');
    for (const fix of fixes) expect(text).toContain(fix);
    // order preserved within the criterion
    expect(text.indexOf(fixes[0]!)).toBeLessThan(text.indexOf(fixes[1]!));
    expect(text.indexOf(fixes[1]!)).toBeLessThan(text.indexOf(fixes[2]!));
  });

  it('AC-2 blocker-first forwarding and perspective attribution are unchanged', () => {
    const blocker = finding('AC-9', 'blocker', ['only fix']);
    const minor = finding('AC-8', 'minor', ['cosmetic fix']);
    const panel = buildPanelRepairBrief([
      run('EVAL-1', 'testQuality', [blocker, minor]),
      run('EVAL-2', 'codeQuality', [finding('AC-9', 'blocker', ['only fix'])]),
    ]);
    // blocker-first: the minor AC-8 is suppressed while a blocker exists
    expect(panel.instructions.every((i) => i.criterionId === 'AC-9')).toBe(true);
    // attribution: both lenses that raised AC-9 are named
    expect(panel.instructions[0]!.perspectives).toEqual(['codeQuality', 'testQuality']);
  });
});
