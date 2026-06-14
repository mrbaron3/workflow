import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from '../src/store/store.js';
import { computeMetrics } from '../src/metrics/metrics.js';
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
function addRun(store: Store, issueId: string, sample: number, attempt: number, verdict: Verdict): void {
  store.addEvalRun(
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

  it('reports false-pass / false-fail once runs carry human labels', () => {
    const store = tmpStore('metrics-labels');
    addIssue(store, 'ISSUE-0001');
    addRun(store, 'ISSUE-0001', 0, 1, 'approve');
    addRun(store, 'ISSUE-0001', 1, 1, 'request_changes');
    // label: the approve was actually wrong (false pass), the request_changes was right
    store.db.evalRuns[0]!.humanVerdict = 'request_changes';
    store.db.evalRuns[1]!.humanVerdict = 'request_changes';
    const m = computeMetrics(store);
    expect(m.falsePassRate).toBeCloseTo(0.5, 5);
    expect(m.falseFailRate).toBeCloseTo(0, 5);
    expect(m.graderAgreement).toBeCloseTo(0.5, 5);
  });
});
