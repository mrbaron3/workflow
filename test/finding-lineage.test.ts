/**
 * Finding lineage — attested by the reviewer, never inferred (ISSUE-0009). The grounded ⑥
 * evidence showed criterionId recurrence misattributes both ways: different findings on the
 * same AC id were called "the same", and the one truly persisted finding crossed AC ids and
 * was missed. So the re-review prompt demands a persisted/new attestation per finding
 * (AC-LINEAGE-001), the attestation rides zod validation into EvalRun.findings — store = SoT,
 * absence tolerated as legacy (AC-LINEAGE-002) — and the Analyst's failed-to-land rule
 * consumes ONLY attested `lineage: 'persisted'` findings (AC-LINEAGE-003).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, nowISO } from '../src/store/store.js';
import { EvalRun, Finding } from '../src/domain/schema.js';
import { analyzeHarness } from '../src/pipeline/analyst.js';
import { perspectivePrompt, promptForLens, parsePerspectiveFindings } from '../src/pipeline/execution/perspective-session.js';
import { priorFindingsByLens } from '../src/pipeline/execution/live.js';
import type { IssueContract } from '../src/domain/schema.js';
import type { Metrics } from '../src/metrics/metrics.js';

const dirs: string[] = [];
function freshStore(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-lineage-'));
  dirs.push(root);
  return new Store(root);
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const contract: IssueContract = {
  productGoal: 'g', userStory: 'u', scope: { include: [], exclude: [] },
  acceptanceCriteria: [
    { id: 'AC-Z-1', severity: 'blocker', behavior: 'b', verification: { method: 'unit_test', expected: ['x'] } },
  ],
  redLines: [],
};

/** Healthy metrics so the threshold rules stay silent; the lineage rule reads the runs. */
function healthyMetrics(): Metrics {
  return {
    totals: { epics: 0, issues: 1, issuesRun: 1, released: 1, samples: 2, evalRuns: 2 },
    passAt1: 1, passAtK: 1, passHatK: 1, headlineK: 2, repairSuccessRate: 1, prPassRate: 1,
    avgRepairAttempts: 1, instabilityRate: 0, cost: { usd: 0, tokens: 0, seconds: 0 },
    falsePassRate: 0, falseFailRate: 0, graderAgreement: 1, regressionCaptureRate: null,
    regressionExecutedRate: null, regressionFailingTasks: 0, regressionUnverifiedTasks: 0,
    falsePassTrend: [], passCurve: [], byAgent: [],
    heatmap: { areas: [], types: [], counts: {}, max: 0 }, issues: [],
  };
}

/** One perspective run; `lineage` per finding rides through EvalRun.parse (or is absent = legacy). */
function seedRun(
  store: Store, issueId: string, attempt: number, lens: string | null,
  findings: { criterionId: string; lineage?: 'persisted' | 'new' }[],
  prId = 'PR-1',
): void {
  store.addEvalRun(EvalRun.parse({
    id: `EVAL-${store.db.evalRuns.length + 1}`, issueId, prId, attempt, sampleIndex: 0,
    agent: 'claude', perspective: lens, verdict: findings.length ? 'request_changes' : 'approve',
    findings: findings.map((f) => ({
      criterionId: f.criterionId, severity: 'major', expected: 'e', observed: `observed ${f.criterionId}`,
      ...(f.lineage ? { lineage: f.lineage } : {}),
    })),
    scores: { functionality: 0, codeQuality: 0, testQuality: 0, ux: 0, accessibility: 0 },
    overall: 0.3, cost: {}, createdAt: nowISO(),
  }));
}

const failedToLand = (s: { title: string; rationale: string }[]) =>
  s.filter((x) => /failed to land|不着/i.test(x.title));

describe('perspectivePrompt with prior findings (re-review)', () => {
  it('ISSUE-0009/AC-LINEAGE-001 presents each prior finding and demands a persisted/new attestation', () => {
    const prior = [
      { criterionId: 'AC-Z-1', observed: 'the cap is an untested inline literal' },
      { criterionId: 'AC-Z-2', observed: 'assertion weakened to pass' },
    ];
    const prompt = perspectivePrompt('testQuality', contract, '.agentops/eval/testQuality', prior);
    for (const f of prior) {
      expect(prompt).toContain(f.criterionId); // the reviewer sees WHICH criterion was flagged
      expect(prompt).toContain(f.observed); // and WHAT was observed
    }
    expect(prompt).toMatch(/persisted/i); // the attestation is demanded, both values named
    expect(prompt).toMatch(/"new"/i);
    expect(prompt).toContain('lineage'); // and the findings.json contract carries the field
  });

  it('ISSUE-0009/AC-LINEAGE-001 without prior findings the prompt is unchanged (attempt 1)', () => {
    const first = perspectivePrompt('testQuality', contract, '.agentops/eval/testQuality');
    expect(first).not.toMatch(/persisted/i);
    expect(first).not.toContain('lineage');
    // empty priors = no priors: byte-identical to the legacy prompt
    expect(perspectivePrompt('testQuality', contract, '.agentops/eval/testQuality', [])).toBe(first);
  });

  it('ISSUE-0009/AC-LINEAGE-001 the handoff seam: a lens absent from the map keeps the attempt-1 prompt; a sibling with priors is re-reviewed', () => {
    const priors = {
      codeQuality: [{ criterionId: 'AC-Z-1', observed: 'duplicated helper left behind' }],
      testQuality: [{ criterionId: 'AC-Z-2', observed: 'tautological assertion' }],
    };
    // absent from the map — and no map at all (attempt 1) — is byte-identical to the first review
    const first = perspectivePrompt('security', contract, '.agentops/eval/security');
    expect(promptForLens('security', contract, '.agentops/eval/security', priors)).toBe(first);
    expect(promptForLens('security', contract, '.agentops/eval/security')).toBe(first);
    // keyed in the map: the re-review prompt carries ITS OWN priors, never a sibling's
    const cq = promptForLens('codeQuality', contract, '.agentops/eval/codeQuality', priors);
    expect(cq).toContain('duplicated helper left behind');
    expect(cq).toMatch(/persisted/i);
    expect(cq).not.toContain('tautological assertion'); // mis-keying would leak testQuality's priors
  });
});

describe('priorFindingsByLens — the store→re-review selection (pure, like collectFindings)', () => {
  it("ISSUE-0009/AC-LINEAGE-001 attempt-2 selection hands each lens only ITS OWN attempt-1 findings for this PR", () => {
    const store = freshStore();
    seedRun(store, 'ISSUE-A', 1, 'codeQuality', [{ criterionId: 'AC-Z-1' }]);
    seedRun(store, 'ISSUE-A', 1, 'testQuality', [{ criterionId: 'AC-Z-2' }]);
    seedRun(store, 'ISSUE-A', 1, null, [{ criterionId: 'GATE-typecheck' }]); // perspective=null gate run
    seedRun(store, 'ISSUE-B', 1, 'codeQuality', [{ criterionId: 'AC-OTHER' }], 'PR-2'); // another PR
    const byLens = priorFindingsByLens(store, 'PR-1', 2);
    expect(Object.keys(byLens).sort()).toEqual(['codeQuality', 'testQuality']); // no gate key, no PR-2 leak
    expect(byLens['codeQuality']!.map((f) => f.criterionId)).toEqual(['AC-Z-1']); // own lens, own PR only
    expect(byLens['testQuality']!.map((f) => f.criterionId)).toEqual(['AC-Z-2']);
  });

  it('ISSUE-0009/AC-LINEAGE-001 attempt-3 selection returns attempt-2 findings, not attempt-1', () => {
    const store = freshStore();
    seedRun(store, 'ISSUE-A', 1, 'codeQuality', [{ criterionId: 'AC-FIRST' }]);
    seedRun(store, 'ISSUE-A', 2, 'codeQuality', [{ criterionId: 'AC-SECOND', lineage: 'persisted' }]);
    const byLens = priorFindingsByLens(store, 'PR-1', 3);
    expect(Object.keys(byLens)).toEqual(['codeQuality']);
    expect(byLens['codeQuality']!.map((f) => f.criterionId)).toEqual(['AC-SECOND']); // the immediately previous attempt
  });

  it('ISSUE-0009/AC-LINEAGE-001 attempt 1 selects nothing — every lens keeps its first-review prompt', () => {
    const store = freshStore();
    seedRun(store, 'ISSUE-A', 1, 'codeQuality', [{ criterionId: 'AC-Z-1' }]);
    expect(priorFindingsByLens(store, 'PR-1', 1)).toEqual({});
  });
});

describe('lineage through validation into the store (SoT)', () => {
  it('ISSUE-0009/AC-LINEAGE-002 parsePerspectiveFindings preserves persisted/new and rejects invalid values', () => {
    const parsed = parsePerspectiveFindings({
      verdict: 'request_changes',
      findings: [
        { criterionId: 'AC-Z-1', severity: 'major', observed: 'o', expected: 'e', lineage: 'persisted' },
        { criterionId: 'AC-Z-2', severity: 'minor', observed: 'o2', expected: 'e2', lineage: 'new' },
      ],
    });
    expect(parsed.findings[0]!.lineage).toBe('persisted');
    expect(parsed.findings[1]!.lineage).toBe('new');

    expect(() => parsePerspectiveFindings({
      verdict: 'request_changes',
      findings: [{ criterionId: 'AC-Z-1', severity: 'major', observed: 'o', expected: 'e', lineage: 'maybe' }],
    })).toThrow(); // an invalid attestation never reaches the store
  });

  it('ISSUE-0009/AC-LINEAGE-002 a finding without lineage is accepted and stays unclassified (legacy)', () => {
    const parsed = parsePerspectiveFindings({
      verdict: 'request_changes',
      findings: [{ criterionId: 'AC-Z-1', severity: 'major', observed: 'o', expected: 'e' }],
    });
    expect(parsed.findings[0]!.lineage).toBeUndefined(); // absent stays absent — never silently classified
    expect(() => Finding.parse({ criterionId: 'C', severity: 'major', expected: 'e', observed: 'o', lineage: 'resolved' })).toThrow();
  });

  it('ISSUE-0009/AC-LINEAGE-002 lineage survives EvalRun.findings through a store save/load round-trip', () => {
    const store = freshStore();
    seedRun(store, 'ISSUE-A', 2, 'codeQuality', [
      { criterionId: 'AC-Z-1', lineage: 'persisted' },
      { criterionId: 'AC-Z-2' }, // legacy: no lineage
    ]);
    store.save();
    const reloaded = new Store(store.root); // DB.parse on load — the persisted record is the SoT
    const findings = reloaded.db.evalRuns[0]!.findings;
    expect(findings[0]!.lineage).toBe('persisted');
    expect(findings[1]!.lineage).toBeUndefined();
  });
});

describe('Analyst failed-to-land rule consumes only attested lineage', () => {
  it('ISSUE-0009/AC-LINEAGE-003 all-new re-review findings are not a brief failure (even on the same criterionId)', () => {
    const store = freshStore();
    seedRun(store, 'ISSUE-A', 1, 'codeQuality', [{ criterionId: 'AC-Z-1' }]);
    seedRun(store, 'ISSUE-A', 2, 'codeQuality', [{ criterionId: 'AC-Z-1', lineage: 'new' }]);
    expect(failedToLand(analyzeHarness(store, healthyMetrics()))).toHaveLength(0);
  });

  it('ISSUE-0009/AC-LINEAGE-003 an attested persisted finding is a brief failure, counted alone (criterionId may differ from attempt 1)', () => {
    const store = freshStore();
    seedRun(store, 'ISSUE-B', 1, 'codeQuality', [{ criterionId: 'AC-Z-1' }]);
    seedRun(store, 'ISSUE-B', 2, 'codeQuality', [
      { criterionId: 'AC-Z-9', lineage: 'persisted' }, // the true survivor crossed AC ids
      { criterionId: 'AC-Z-5', lineage: 'new' },
    ]);
    const hits = failedToLand(analyzeHarness(store, healthyMetrics()));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.rationale).toContain('ISSUE-B');
    expect(hits[0]!.rationale).toContain('AC-Z-9'); // the attested survivor is the evidence
    expect(hits[0]!.rationale).not.toContain('AC-Z-5'); // the new finding is NOT a survivor
  });

  it('ISSUE-0009/AC-LINEAGE-003 a legacy re-review without lineage is indeterminate — never a brief failure', () => {
    const store = freshStore();
    seedRun(store, 'ISSUE-C', 1, 'codeQuality', [{ criterionId: 'AC-Z-1' }]);
    seedRun(store, 'ISSUE-C', 2, 'codeQuality', [{ criterionId: 'AC-Z-1' }]); // no attestation
    expect(failedToLand(analyzeHarness(store, healthyMetrics()))).toHaveLength(0);
  });
});
