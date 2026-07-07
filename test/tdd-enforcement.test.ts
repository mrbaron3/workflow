/**
 * TDD enforcement at the Generator level, on three reinforcing layers:
 *   1. the generator ROLE PROMPT mandates test-first (red → green), AC-id-tagged test
 *      titles (the convention grading AND the regression executor bind on), and forbids
 *      weakening existing tests;
 *   2. the testQuality REVIEW LENS (an independent read-only session — the "other agent"
 *      that reviews test content) is briefed with a validity rubric: would each test fail
 *      if the behaviour broke, are assertions tautology-free, is every AC tagged;
 *   3. the DETERMINISTIC grader closes the silent-pass hole: a unit_test AC with NO
 *      tagged assertion in an available report is NOT satisfied (previously it fell back
 *      to suite-green, so an agent could skip AC-tagged tests entirely and still pass).
 */
import { describe, it, expect } from 'vitest';
import { buildGeneratorPrompt, type GeneratorSessionInput } from '../src/pipeline/execution/session.js';
import { perspectivePrompt } from '../src/pipeline/execution/perspective-session.js';
import { satisfiedFromReport, type VitestReport } from '../src/pipeline/execution/grade.js';
import { Issue, type IssueContract } from '../src/domain/schema.js';
import type { TargetRepoConfig } from '../src/config.js';

const contract: IssueContract = {
  productGoal: 'g',
  userStory: 'u',
  scope: { include: ['src/**'], exclude: [] },
  acceptanceCriteria: [
    { id: 'AC-1', severity: 'blocker', behavior: 'does the thing', verification: { method: 'unit_test', expected: ['x'] } },
    { id: 'AC-2', severity: 'major', behavior: 'renders the flow', verification: { method: 'playwright', expected: ['y'] } },
  ],
  redLines: [],
};

function report(assertions: { name: string; passed: boolean }[]): VitestReport {
  return {
    success: assertions.every((a) => a.passed),
    total: assertions.length,
    passed: assertions.filter((a) => a.passed).length,
    failedNames: assertions.filter((a) => !a.passed).map((a) => a.name),
    assertions,
  };
}

// --- 1. the generator role prompt mandates TDD -----------------------------------------

describe('generator prompt: TDD is mandated, not optional', () => {
  const input: GeneratorSessionInput = {
    issue: Issue.parse({
      id: 'ISSUE-1', type: 'story', title: 't', area: 'backend', status: 'contract-drafted',
      assignedAgent: 'claude', contract, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }),
    contract, sampleIndex: 0, attempt: 1, repairBrief: null,
  };
  const target: TargetRepoConfig = { repo: '.' };
  const prompt = buildGeneratorPrompt(input, target);

  it('demands test-first: write the failing test before the implementation', () => {
    expect(prompt).toMatch(/failing test/i);
    expect(prompt).toMatch(/before/i);
  });

  it('demands AC-id-tagged test titles (grading and regression execution bind on them)', () => {
    expect(prompt).toMatch(/title.*AC id|AC id.*title/i);
  });

  it('forbids deleting or weakening existing tests to get green', () => {
    expect(prompt).toMatch(/do not (delete|weaken)/i);
  });
});

// --- 2. the independent testQuality lens carries a validity rubric ---------------------

describe('testQuality lens: the other agent reviews test CONTENT validity', () => {
  const tq = perspectivePrompt('testQuality', contract, '.agentops/eval/testQuality');

  it('asks whether each test would FAIL if the behaviour broke (no tautologies)', () => {
    expect(tq).toMatch(/would .*fail/i);
    expect(tq).toMatch(/tautolog/i);
  });

  it('checks the AC-id tagging convention and may run the suite to verify', () => {
    expect(tq).toMatch(/AC id/);
    expect(tq).toMatch(/run the test/i);
  });

  it('other lenses are NOT burdened with the test-validity rubric', () => {
    const cq = perspectivePrompt('codeQuality', contract, '.agentops/eval/codeQuality');
    expect(cq).not.toMatch(/tautolog/i);
  });
});

// --- 3. the deterministic gate: no tagged assertion => not satisfied --------------------

describe('satisfiedFromReport: unit_test ACs require a tagged assertion (no silent pass)', () => {
  it('tagged and green → satisfied; tagged with a failure → not satisfied', () => {
    const ok = satisfiedFromReport(contract, report([{ name: 'x AC-1 works', passed: true }]));
    expect(ok.satisfied['AC-1']).toBe(true);
    const bad = satisfiedFromReport(contract, report([{ name: 'x AC-1 works', passed: false }]));
    expect(bad.satisfied['AC-1']).toBe(false);
  });

  it('a unit_test AC with NO tagged assertion is NOT satisfied even when the suite is green', () => {
    const r = satisfiedFromReport(contract, report([{ name: 'unrelated test', passed: true }]));
    expect(r.satisfied['AC-1']).toBe(false); // the closed hole
    expect(r.untaggedUnitTestAcs).toContain('AC-1'); // surfaced for notes/repair, not silent
  });

  it('non-unit_test methods keep the suite-green fallback (vitest cannot verify them)', () => {
    const r = satisfiedFromReport(contract, report([{ name: 'unrelated test', passed: true }]));
    expect(r.satisfied['AC-2']).toBe(true); // playwright AC: fallback, unchanged behaviour
  });

  it('with no report at all (no unit_tests grader configured) everything falls back to true', () => {
    const r = satisfiedFromReport(contract, null);
    expect(r.satisfied).toEqual({ 'AC-1': true, 'AC-2': true });
    expect(r.untaggedUnitTestAcs).toEqual([]);
  });
});
