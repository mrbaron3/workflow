/**
 * Env-gated acceptance grader for ISSUE-0009 "finding lineage" — adopted from the Analyst's
 * "repair briefs failed to land" proposal, SHARPENED by the ⑥ grounded evidence: all three
 * claimed "survivors" were misattributed (criterionId matching across attempts — and even
 * across lenses — called different findings "the same", while the one finding that truly
 * persisted crossed AC ids and was missed). Contract: scripts/seeds/finding-lineage.contract.yaml
 * (AC-LINEAGE-001..003).
 *
 * This began as the env-gated acceptance grader for the drive — red at baseline BY DESIGN,
 * collected only under ACCEPT_HARNESS=1 (ADR-0007 I3). The build was human-approved and
 * released (2026-07-08, one repair round; the surviving minor — the rule's attempt<=1
 * boundary unpinned — was made a RELEASE CONDITION and is pinned below, ⑥'s conditional-
 * approval pattern). skipIf dropped: permanent regression guard, protectedPaths.
 *
 * Seams this file pins:
 *   - perspectivePrompt gains an OPTIONAL prior-findings argument: a re-review prompt
 *     presents the same lens's previous-attempt findings and demands a persisted/new
 *     lineage attestation per finding; without it the prompt is unchanged (attempt 1).
 *   - Finding gains optional `lineage: 'persisted' | 'new'` — validated by
 *     parsePerspectiveFindings, preserved through to EvalRun.findings; absent = legacy.
 *   - analyzeHarness's failed-to-land rule consumes ONLY attested `lineage: 'persisted'`
 *     findings — never criterionId coincidence.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, nowISO } from '../../src/store/store.js';
import { EvalRun, Issue } from '../../src/domain/schema.js';
import { analyzeHarness } from '../../src/pipeline/analyst.js';
import { perspectivePrompt, parsePerspectiveFindings } from '../../src/pipeline/execution/perspective-session.js';
import type { Metrics } from '../../src/metrics/metrics.js';

const dirs: string[] = [];
function freshStore(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-lineage-'));
  dirs.push(root);
  return new Store(root);
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const contract = {
  productGoal: 'g', userStory: 'u', scope: { include: [], exclude: [] },
  acceptanceCriteria: [
    { id: 'AC-Z-1', severity: 'blocker' as const, behavior: 'b', verification: { method: 'unit_test' as const, expected: ['x'] } },
  ],
  redLines: [],
};

/** Healthy metrics so unrelated Analyst rules stay quiet; the lineage rule reads the runs. */
function healthyMetrics(): Metrics {
  return {
    totals: { epics: 0, issues: 1, issuesRun: 1, released: 1, samples: 2, evalRuns: 2 },
    passAt1: 1, passAtK: 1, passHatK: 1, headlineK: 2, repairSuccessRate: 1, prPassRate: 1,
    avgRepairAttempts: 1, instabilityRate: 0, cost: { usd: 0, tokens: 0, seconds: 0 },
    falsePassRate: 0, falseFailRate: 0, graderAgreement: 1, regressionCaptureRate: 1,
    regressionExecutedRate: 1, regressionFailingTasks: 0, regressionUnverifiedTasks: 0,
    interventionsPerIssue: 0, howNonInterventionRate: 1,
    lastTurnPeakConcurrency: null, lastTurnIssuesDriven: null, lastTurnCap: null,
    falsePassTrend: [], passCurve: [], byAgent: [], byInvocationProvider: [],
    heatmap: { areas: [], types: [], counts: {}, max: 0 }, issues: [],
  } as Metrics;
}

function seedIssue(store: Store, id: string): void {
  store.addIssue(
    Issue.parse({
      id, type: 'story', title: 't', area: 'backend', status: 'changes-requested',
      assignedAgent: 'claude', contract, createdAt: nowISO(), updatedAt: nowISO(),
    }),
  );
}

/** One perspective run with findings; `lineage` per finding rides through EvalRun.parse. */
function seedRun(
  store: Store, issueId: string, attempt: number, lens: string,
  findings: { criterionId: string; lineage?: 'persisted' | 'new' }[],
): void {
  store.addEvalRun(
    EvalRun.parse({
      id: `EVAL-${store.db.evalRuns.length + 1}`, issueId, prId: 'PR-1', attempt, sampleIndex: 0,
      agent: 'claude', perspective: lens, verdict: findings.length ? 'request_changes' : 'approve',
      findings: findings.map((f) => ({
        criterionId: f.criterionId, severity: 'major', expected: 'e', observed: `observed ${f.criterionId}`,
        ...(f.lineage ? { lineage: f.lineage } : {}),
      })),
      scores: { functionality: 0, codeQuality: 0, testQuality: 0, ux: 0, accessibility: 0 },
      overall: 0.3, cost: {}, createdAt: nowISO(),
    }),
  );
}

const failedToLand = (s: { title: string; rationale: string }[]) =>
  s.filter((x) => /failed to land|不着/i.test(x.title));

describe('finding lineage — attested, never inferred (ISSUE-0009)', () => {
  it('gate condition: a first attempt is never a brief failure — even a (nonsensical) persisted attestation on attempt 1 is ignored', () => {
    // The released panel's surviving minor: analyst.ts guards `attempt <= 1` but no test pinned
    // it. A brief only exists AFTER a repair round, so attempt-1 findings can survive nothing.
    const store = freshStore();
    seedIssue(store, 'ISSUE-D');
    seedRun(store, 'ISSUE-D', 1, 'codeQuality', [{ criterionId: 'AC-Z-1', lineage: 'persisted' }]);
    expect(failedToLand(analyzeHarness(store, healthyMetrics()))).toHaveLength(0);
  });

  it('ISSUE-0009/AC-LINEAGE-001 a re-review prompt presents prior findings and demands a persisted/new attestation; attempt 1 is unchanged', () => {
    const prior = [
      { criterionId: 'AC-Z-1', severity: 'major', observed: 'the cap is an untested inline literal', expected: 'pin it' },
    ];
    const prompt = (perspectivePrompt as unknown as (...a: unknown[]) => string)(
      'testQuality', contract, '.agentops/eval/testQuality', prior,
    );
    expect(prompt).toContain('AC-Z-1');
    expect(prompt).toContain('the cap is an untested inline literal'); // the reviewer sees WHAT was flagged
    expect(prompt).toMatch(/persisted/i); // and must attest lineage
    expect(prompt).toMatch(/new/i);

    const first = perspectivePrompt('testQuality', contract, '.agentops/eval/testQuality');
    expect(first).not.toMatch(/persisted/i); // attempt 1: unchanged, no lineage section
  });

  it('ISSUE-0009/AC-LINEAGE-002 lineage survives validation into findings; invalid values rejected; absence tolerated', () => {
    const parsed = parsePerspectiveFindings({
      verdict: 'request_changes',
      findings: [
        { criterionId: 'AC-Z-1', severity: 'major', observed: 'o', expected: 'e', lineage: 'persisted' },
        { criterionId: 'AC-Z-2', severity: 'minor', observed: 'o2', expected: 'e2', lineage: 'new' },
        { criterionId: 'AC-Z-3', severity: 'minor', observed: 'o3', expected: 'e3' }, // legacy: no lineage
      ],
    });
    const lin = (i: number) => (parsed.findings[i] as { lineage?: string }).lineage;
    expect(lin(0)).toBe('persisted');
    expect(lin(1)).toBe('new');
    expect(lin(2)).toBeUndefined(); // absent stays absent — never silently classified

    expect(() =>
      parsePerspectiveFindings({
        verdict: 'request_changes',
        findings: [{ criterionId: 'AC-Z-1', severity: 'major', observed: 'o', expected: 'e', lineage: 'maybe' }],
      }),
    ).toThrow(); // an invalid attestation never reaches the store
  });

  it('ISSUE-0009/AC-LINEAGE-003 the failed-to-land rule counts ONLY attested persisted findings — never criterionId coincidence', () => {
    // (a) same criterionId re-flagged, but attested NEW → not a brief failure (the ⑥ false positive).
    const a = freshStore();
    seedIssue(a, 'ISSUE-A');
    seedRun(a, 'ISSUE-A', 1, 'codeQuality', [{ criterionId: 'AC-Z-1' }]);
    seedRun(a, 'ISSUE-A', 2, 'codeQuality', [{ criterionId: 'AC-Z-1', lineage: 'new' }]);
    expect(failedToLand(analyzeHarness(a, healthyMetrics()))).toHaveLength(0);

    // (b) DIFFERENT criterionId, attested persisted → IS a brief failure (the ⑥ false negative:
    // the one真の残存 crossed AC ids and the old rule missed it).
    const b = freshStore();
    seedIssue(b, 'ISSUE-B');
    seedRun(b, 'ISSUE-B', 1, 'codeQuality', [{ criterionId: 'AC-Z-1' }]);
    seedRun(b, 'ISSUE-B', 2, 'codeQuality', [
      { criterionId: 'AC-Z-9', lineage: 'persisted' },
      { criterionId: 'AC-Z-5', lineage: 'new' },
    ]);
    const hits = failedToLand(analyzeHarness(b, healthyMetrics()));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.rationale).toContain('AC-Z-9'); // the attested survivor is the evidence
    expect(hits[0]!.rationale).not.toContain('AC-Z-5'); // the new finding is NOT counted as a survivor

    // (c) legacy re-review without lineage → indeterminate, never claimed as a brief failure.
    const c = freshStore();
    seedIssue(c, 'ISSUE-C');
    seedRun(c, 'ISSUE-C', 1, 'codeQuality', [{ criterionId: 'AC-Z-1' }]);
    seedRun(c, 'ISSUE-C', 2, 'codeQuality', [{ criterionId: 'AC-Z-1' }]); // no attestation
    expect(failedToLand(analyzeHarness(c, healthyMetrics()))).toHaveLength(0);
  });
});
