/**
 * Analyst granularity (handoff §4 frontier): grounded runs showed the templated,
 * threshold-only suggestions ("pass@1 is low") sit far from the contract a human actually
 * adopts — the ③ proposal stage had low resolution. Three deterministic failure-class
 * rules raise it, each citing SPECIFICS from the store, and suggestions can now carry a
 * DRAFT contract that createSuggestionIssues attaches and adopt uses as the default —
 * the human still confirms the WHAT by adopting; only the sharpening cost drops.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, nowISO } from '../src/store/store.js';
import { Issue, EvalRun, EvalTask, RegressionRun, type Finding } from '../src/domain/schema.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import { analyzeHarness, createSuggestionIssues } from '../src/pipeline/analyst.js';
import { adoptIssue } from '../src/pipeline/adopt.js';
import { pollable } from '../src/pipeline/execution/guard.js';
import type { Metrics } from '../src/metrics/metrics.js';

const CONFIG: HarnessConfig = { ...DEFAULT_CONFIG, generator: 'claude' };

const dirs: string[] = [];
function freshStore(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-analyst-'));
  dirs.push(root);
  return new Store(root);
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** Healthy metrics so the legacy threshold rules stay silent and only the new rules speak. */
function healthyMetrics(): Metrics {
  return {
    totals: { epics: 0, issues: 1, issuesRun: 1, released: 0, samples: 2, evalRuns: 2 },
    passAt1: 1, passAtK: 1, passHatK: 1, headlineK: 2, repairSuccessRate: 1, prPassRate: 1,
    avgRepairAttempts: 1, instabilityRate: 0, cost: { usd: 0, tokens: 0, seconds: 0 },
    falsePassRate: 0, falseFailRate: 0, graderAgreement: 1, regressionCaptureRate: null,
    regressionExecutedRate: null, regressionFailingTasks: 0, regressionUnverifiedTasks: 0,
    interventionsPerIssue: 0, howNonInterventionRate: 1,
    falsePassTrend: [], passCurve: [], byAgent: [],
    heatmap: { areas: [], types: [], counts: {}, max: 0 }, issues: [],
  };
}

function finding(criterionId: string, severity: Finding['severity'] = 'blocker', lineage?: Finding['lineage']): Finding {
  return { criterionId, severity, expected: 'e', observed: 'o', reproductionSteps: [], evidence: {}, requiredFix: [`fix ${criterionId}`], ...(lineage ? { lineage } : {}) };
}

let seq = 0;
function addRun(store: Store, issueId: string, prId: string, attempt: number, findings: Finding[]): void {
  store.addEvalRun(EvalRun.parse({
    id: `EVAL-${++seq}`, issueId, prId, attempt, sampleIndex: 0, agent: 'claude',
    verdict: findings.length ? 'request_changes' : 'approve', findings,
    scores: { functionality: 0, codeQuality: 0, testQuality: 0, ux: 0, accessibility: 0 },
    overall: 0.5, cost: {}, createdAt: nowISO(),
  }));
}

describe('R1: a finding that survived a repair attempt → repair-brief suggestion with a draft contract', () => {
  it('fires when a re-review finding is attested lineage=persisted, citing specifics', () => {
    const store = freshStore();
    addRun(store, 'ISSUE-0007', 'PR-1', 1, [finding('AC-2')]);
    addRun(store, 'ISSUE-0007', 'PR-1', 2, [finding('AC-2', 'blocker', 'persisted')]); // the brief did not land — attested (ISSUE-0009)

    const s = analyzeHarness(store, healthyMetrics());
    const r1 = s.find((x) => /survived a repair/i.test(x.title));
    expect(r1).toBeDefined();
    expect(r1!.type).toBe('harness');
    expect(r1!.rationale).toContain('ISSUE-0007');
    expect(r1!.rationale).toContain('AC-2');
    // the draft contract is adopt-grade: scoped to the repair router, with unit_test ACs
    expect(r1!.draftContract).toBeDefined();
    expect(r1!.draftContract!.scope.include).toContain('src/pipeline/repair.ts');
    expect(r1!.draftContract!.acceptanceCriteria.length).toBeGreaterThan(0);
  });

  it('stays silent when the next attempt cleared the finding (the brief landed)', () => {
    const store = freshStore();
    addRun(store, 'ISSUE-0007', 'PR-1', 1, [finding('AC-2')]);
    addRun(store, 'ISSUE-0007', 'PR-1', 2, []); // fixed
    expect(analyzeHarness(store, healthyMetrics()).some((x) => /survived a repair/i.test(x.title))).toBe(false);
  });
});

describe('R2: the same hard gate failing repeatedly → targeted suggestion', () => {
  it('fires on ≥2 GATE-scope_check findings, citing the gate and the issues', () => {
    const store = freshStore();
    addRun(store, 'ISSUE-0007', 'PR-1', 1, [finding('GATE-scope_check')]);
    addRun(store, 'ISSUE-0008', 'PR-2', 1, [finding('GATE-scope_check')]);

    const r2 = analyzeHarness(store, healthyMetrics()).find((x) => /scope_check/.test(x.title));
    expect(r2).toBeDefined();
    expect(r2!.type).toBe('harness');
    expect(r2!.rationale).toContain('ISSUE-0007');
    expect(r2!.rationale).toContain('ISSUE-0008');
  });

  it('one occurrence is not a pattern', () => {
    const store = freshStore();
    addRun(store, 'ISSUE-0007', 'PR-1', 1, [finding('GATE-scope_check')]);
    expect(analyzeHarness(store, healthyMetrics()).some((x) => /scope_check/.test(x.title))).toBe(false);
  });
});

describe('R3: registry hygiene → eval suggestion citing the tasks', () => {
  it('fires on unbound tasks and on tasks whose latest execution is unverified', () => {
    const store = freshStore();
    store.addEvalTask(EvalTask.parse({
      id: 'EVAL-TASK-ISSUE-0001-AC-1', sourceIssueId: 'ISSUE-0001', featureArea: 'backend',
      userGoal: 'g', graders: ['unit_test'], severity: 'blocker', createdAt: nowISO(), // target null = unbound
    }));
    store.addEvalTask(EvalTask.parse({
      id: 'EVAL-TASK-ISSUE-0002-AC-1', sourceIssueId: 'ISSUE-0002', featureArea: 'backend',
      userGoal: 'g', graders: ['unit_test'], severity: 'blocker', createdAt: nowISO(), target: '.',
    }));
    store.addRegressionRun(RegressionRun.parse({
      id: 'REGRUN-0001', taskId: 'EVAL-TASK-ISSUE-0002-AC-1', target: '.',
      result: 'unverified', matchedAssertions: 0, createdAt: nowISO(),
    }));

    const r3 = analyzeHarness(store, healthyMetrics()).find((x) => /registry/i.test(x.title));
    expect(r3).toBeDefined();
    expect(r3!.type).toBe('eval');
    expect(r3!.rationale).toContain('EVAL-TASK-ISSUE-0001-AC-1'); // unbound
    expect(r3!.rationale).toContain('EVAL-TASK-ISSUE-0002-AC-1'); // unverified
  });

  it('a healthy registry (bound, verified) raises nothing', () => {
    const store = freshStore();
    store.addEvalTask(EvalTask.parse({
      id: 'EVAL-TASK-ISSUE-0002-AC-1', sourceIssueId: 'ISSUE-0002', featureArea: 'backend',
      userGoal: 'g', graders: ['unit_test'], severity: 'blocker', createdAt: nowISO(), target: '.',
    }));
    store.addRegressionRun(RegressionRun.parse({
      id: 'REGRUN-0001', taskId: 'EVAL-TASK-ISSUE-0002-AC-1', target: '.',
      result: 'pass', matchedAssertions: 2, createdAt: nowISO(),
    }));
    expect(analyzeHarness(store, healthyMetrics()).some((x) => /registry/i.test(x.title))).toBe(false);
  });
});

describe('draft contract piping: suggestion → issue → adopt (the human still confirms)', () => {
  it('createSuggestionIssues attaches the draft; adopt uses it when no contract is passed', () => {
    const store = freshStore();
    addRun(store, 'ISSUE-0007', 'PR-1', 1, [finding('AC-2')]);
    addRun(store, 'ISSUE-0007', 'PR-1', 2, [finding('AC-2', 'blocker', 'persisted')]);

    const suggestions = analyzeHarness(store, healthyMetrics());
    const created = createSuggestionIssues(store, suggestions);
    const withDraft = created.find((i) => i.contract !== null)!;
    expect(withDraft).toBeDefined();
    expect(withDraft.status).toBe('planned'); // a draft is NOT drivable yet
    expect(pollable(store, CONFIG)).toEqual([]);

    const adopted = adoptIssue(store, CONFIG, withDraft.id, {}); // no contract passed → draft
    expect(adopted.status).toBe('contract-drafted');
    expect(pollable(store, CONFIG).map((i) => i.id)).toContain(withDraft.id);
  });

  it('adopt still fails loudly when there is neither a passed contract nor a draft', () => {
    const store = freshStore();
    const bare = store.addIssue(Issue.parse({
      id: 'ISSUE-9998', type: 'harness', title: 't', area: 'harness', status: 'planned',
      assignedAgent: null, contract: null, epicId: null, sprint: null, createdAt: nowISO(), updatedAt: nowISO(),
    }));
    expect(() => adoptIssue(store, CONFIG, bare.id, {})).toThrow(/no contract/i);
  });
});
