import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from '../src/store/store.js';
import {
  computeMetrics,
  MIN_HUMAN_DECISIONS_FOR_CALIBRATION,
} from '../src/metrics/metrics.js';
import { statusReport } from '../src/dashboard/dashboard.js';
import { curateEvalTasks } from '../src/pipeline/curator.js';
import { Issue, EvalRun, type Verdict } from '../src/domain/schema.js';

function tmpStore(name: string): Store {
  const dir = path.join(os.tmpdir(), 'agentops-test', `${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return new Store(dir);
}

function addIssue(store: Store, id: string): void {
  store.addIssue(
    Issue.parse({
      id,
      type: 'feature',
      title: id,
      area: 'frontend',
      status: 'released',
      contract: {
        productGoal: 'g',
        userStory: 'u',
        scope: { include: [], exclude: [] },
        acceptanceCriteria: [
          { id: 'AC-001', severity: 'blocker', behavior: 'b', verification: { method: 'playwright', expected: ['x'] } },
        ],
        redLines: [],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
  );
}

let evalCounter = 0;
function addRun(
  store: Store,
  issueId: string,
  sample: number,
  attempt: number,
  verdict: Verdict,
): EvalRun {
  return store.addEvalRun(
    EvalRun.parse({
      id: `EVAL-${++evalCounter}`,
      issueId,
      prId: `PR-${sample}`,
      attempt,
      sampleIndex: sample,
      agent: 'mock',
      verdict,
      hardGates: {},
      findings: verdict === 'approve' ? [] : [
        { criterionId: 'AC-001', severity: 'blocker', expected: 'x', observed: 'y', reproductionSteps: [], evidence: {}, requiredFix: [] },
      ],
      scores: { functionality: 0.8, codeQuality: 0.8, testQuality: 0.8, ux: 0.8, accessibility: 0.8 },
      overall: 0.8,
      cost: { usd: 0.01, tokens: 1000, seconds: 20 },
      featureArea: 'frontend',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
}

describe('computeMetrics: pass@k vs pass^k', () => {
  it('computes the textbook divergence for c=2 of n=3', () => {
    const store = tmpStore('metrics');
    addIssue(store, 'ISSUE-0001');
    // sample 0: fail then pass (repaired)
    addRun(store, 'ISSUE-0001', 0, 1, 'request_changes');
    addRun(store, 'ISSUE-0001', 0, 2, 'approve');
    // sample 1: pass first try
    addRun(store, 'ISSUE-0001', 1, 1, 'approve');
    // sample 2: never passes
    addRun(store, 'ISSUE-0001', 2, 1, 'request_changes');
    addRun(store, 'ISSUE-0001', 2, 2, 'request_changes');
    addRun(store, 'ISSUE-0001', 2, 3, 'request_changes');

    const m = computeMetrics(store);
    expect(m.headlineK).toBe(3);
    // pass@3 with 2/3 passing: any of 3 draws succeeds -> 1
    expect(m.passAtK).toBeCloseTo(1, 5);
    // pass^3 with 2/3 passing: all 3 succeed -> 0
    expect(m.passHatK).toBeCloseTo(0, 5);
    // first-attempt success: only sample 1 -> 1/3
    expect(m.passAt1).toBeCloseTo(1 / 3, 5);
    // failed-first = samples 0 & 2; repaired = sample 0 -> 0.5
    expect(m.repairSuccessRate).toBeCloseTo(0.5, 5);
    // samples disagree (0<2<3) -> instability 1
    expect(m.instabilityRate).toBeCloseTo(1, 5);
  });

  it('counts one human decision when its label is copied to multiple perspective runs', () => {
    const store = tmpStore('metrics-labels');
    addIssue(store, 'ISSUE-0001');
    const functionality = addRun(store, 'ISSUE-0001', 0, 1, 'approve');
    const security = addRun(store, 'ISSUE-0001', 0, 1, 'approve');
    functionality.perspective = 'functionality';
    security.perspective = 'security';
    functionality.humanVerdict = 'request_changes';
    security.humanVerdict = 'request_changes';

    const veto = addRun(store, 'ISSUE-0001', 1, 1, 'request_changes');
    const approvingLens = addRun(store, 'ISSUE-0001', 1, 1, 'approve');
    veto.perspective = 'functionality';
    approvingLens.perspective = 'security';
    veto.humanVerdict = 'approve';
    approvingLens.humanVerdict = 'approve';

    const agreed = addRun(store, 'ISSUE-0001', 2, 1, 'request_changes');
    agreed.humanVerdict = 'request_changes';

    const m = computeMetrics(store);
    expect(m.humanDecisionCount).toBe(3);
    expect(m.falsePassRate).toBeCloseTo(1 / 3, 5);
    expect(m.falseFailRate).toBeCloseTo(1 / 3, 5);
    expect(m.graderAgreement).toBeCloseTo(1 / 3, 5);
    expect(m.falsePassTrend).toHaveLength(3);
  });
});

describe('③ steering instruments (ADR-0007 I4)', () => {
  it('regressionCaptureRate: null with no failures, 0 while uncaptured, 1 once curated', () => {
    const store = tmpStore('metrics-capture');
    addIssue(store, 'ISSUE-0001');
    addRun(store, 'ISSUE-0001', 0, 1, 'approve'); // no findings
    expect(computeMetrics(store).regressionCaptureRate).toBeNull(); // nothing failed yet

    addRun(store, 'ISSUE-0001', 0, 2, 'request_changes'); // blocker finding on AC-001
    expect(computeMetrics(store).regressionCaptureRate).toBe(0); // failed, not yet in the registry

    curateEvalTasks(store); // promotes AC-001 as EVAL-TASK-ISSUE-0001-AC-001
    expect(computeMetrics(store).regressionCaptureRate).toBe(1); // the steering star: captured
  });

  it('regressionCaptureRate ignores lens/gate findings that do not reference a contract AC', () => {
    const store = tmpStore('metrics-capture-lens');
    addIssue(store, 'ISSUE-0001');
    addRun(store, 'ISSUE-0001', 0, 1, 'request_changes');
    // rewrite the finding to a non-AC criterion (a lens-level or gate finding)
    store.db.evalRuns[0]!.findings[0]!.criterionId = 'GATE-scope_check';
    expect(computeMetrics(store).regressionCaptureRate).toBeNull(); // no AC failure observed
  });

  it('regressionCaptureRate keys on the AC severity, not the finding severity (curator semantics)', () => {
    // Grounded discovery (2026-07-07 live run): a review lens filed a MINOR finding against a
    // BLOCKER AC — the curator tags that AC [regression], so the instrument must count it too.
    const store = tmpStore('metrics-capture-sev');
    addIssue(store, 'ISSUE-0001');
    addRun(store, 'ISSUE-0001', 0, 1, 'request_changes');
    store.db.evalRuns[0]!.findings[0]!.severity = 'minor'; // minor finding, blocker AC-001
    expect(computeMetrics(store).regressionCaptureRate).toBe(0); // still an observed failure
    curateEvalTasks(store);
    expect(computeMetrics(store).regressionCaptureRate).toBe(1); // and it is capturable
  });

  it('falsePassTrend follows the labelled timeline, windowed, oldest → newest', () => {
    const store = tmpStore('metrics-trend');
    addIssue(store, 'ISSUE-0001');
    // Three decisions, in time order: false-pass, correct, correct. The first
    // decision has two perspective runs but must contribute only one trend point.
    addRun(store, 'ISSUE-0001', 0, 1, 'approve');
    addRun(store, 'ISSUE-0001', 0, 1, 'approve');
    addRun(store, 'ISSUE-0001', 1, 1, 'request_changes');
    addRun(store, 'ISSUE-0001', 2, 1, 'approve');
    store.db.evalRuns[0]!.createdAt = '2026-01-01T00:00:00.000Z';
    store.db.evalRuns[1]!.createdAt = '2026-01-01T00:00:00.000Z';
    store.db.evalRuns[2]!.createdAt = '2026-01-02T00:00:00.000Z';
    store.db.evalRuns[3]!.createdAt = '2026-01-03T00:00:00.000Z';
    store.db.evalRuns[0]!.humanVerdict = 'request_changes'; // grader approved → false pass
    store.db.evalRuns[1]!.humanVerdict = 'request_changes'; // same decision, copied label
    store.db.evalRuns[2]!.humanVerdict = 'request_changes'; // agreement
    store.db.evalRuns[3]!.humanVerdict = 'approve'; // agreement

    const m = computeMetrics(store);
    expect(m.humanDecisionCount).toBe(3);
    expect(m.falsePassTrend).toHaveLength(3);
    expect(m.falsePassTrend.map((p) => p.rate)).toEqual([1, 1 / 2, 1 / 3]); // cumulative within the window
    expect(m.falsePassTrend[0]!.upTo).toBe('2026-01-01T00:00:00.000Z');
    expect(m.falsePassTrend.at(-1)!.upTo).toBe('2026-01-03T00:00:00.000Z');
  });

  it('falsePassTrend is empty with no labels (nothing to trend)', () => {
    const store = tmpStore('metrics-trend-empty');
    addIssue(store, 'ISSUE-0001');
    addRun(store, 'ISSUE-0001', 0, 1, 'approve');
    expect(computeMetrics(store).falsePassTrend).toEqual([]);
  });
});

describe('statusReport: human calibration sample size', () => {
  it('hides rates below the single calibration threshold and reports the decision count', () => {
    const store = tmpStore('metrics-calibration-thin');
    addIssue(store, 'ISSUE-0001');
    for (let sample = 0; sample < 6; sample++) {
      const run = addRun(store, 'ISSUE-0001', sample, 1, 'approve');
      run.humanVerdict = 'approve';
    }

    const report = statusReport(store, computeMetrics(store));
    expect(report).toContain('false-pass: n/a（較正不足: n=6）');
    expect(report).toContain('false-fail: n/a（較正不足: n=6）');
    expect(report).toContain('grader agreement: n/a（較正不足: n=6）');
    expect(report).not.toContain('false-pass trend:');
  });

  it('shows rates with their denominator once the calibration threshold is met', () => {
    const store = tmpStore('metrics-calibration-ready');
    addIssue(store, 'ISSUE-0001');
    for (let sample = 0; sample < MIN_HUMAN_DECISIONS_FOR_CALIBRATION; sample++) {
      const run = addRun(store, 'ISSUE-0001', sample, 1, 'approve');
      run.humanVerdict = 'approve';
    }

    const report = statusReport(store, computeMetrics(store));
    const denominator = `(n=${MIN_HUMAN_DECISIONS_FOR_CALIBRATION} 判断)`;
    expect(report).toContain(`false-pass: 0.0% ${denominator}`);
    expect(report).toContain(`false-fail: 0.0% ${denominator}`);
    expect(report).toContain(`grader agreement: 100.0% ${denominator}`);
  });
});
