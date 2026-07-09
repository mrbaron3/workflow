/**
 * Proposal lifecycle (ISSUE-0012, FEAT-005): the decline/retire organs and the Analyst's
 * rule-identity dedup (spec docs/specs/proposal-lifecycle-decline-organ-and-analyst-dedup-hygiene).
 *
 * The semantics under test:
 *   - decline (closeIssue) / retire (retireEvalTask) are human JUDGMENT POINTS: explicit,
 *     reason-mandatory, terminal — and auditable from the store alone (ARCH-evaluation-008).
 *   - Retirement is a state, not an erasure: records and capture history survive; only
 *     execution and the executed/unverified accounting exclude retired tasks.
 *   - Analyst inventory identity is the RULE, not the title text: a re-firing rule collapses
 *     into its open issue; a terminal (closed/released) issue never silences re-filing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, nowISO } from '../src/store/store.js';
import { EvalRun, EvalTask, Issue, RegressionRun } from '../src/domain/schema.js';
import { computeMetrics, type Metrics } from '../src/metrics/metrics.js';
import { analyzeHarness, createSuggestionIssues } from '../src/pipeline/analyst.js';
import { runRegressionTasks, type RegressReportRunner } from '../src/pipeline/regression.js';
import { pollable } from '../src/pipeline/execution/guard.js';
import { adoptIssue } from '../src/pipeline/adopt.js';
import { assignIssue } from '../src/pipeline/assign.js';
import { closeIssue, retireEvalTask } from '../src/pipeline/lifecycle.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';

const dirs: string[] = [];
function freshStore(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-lifecycle-'));
  dirs.push(root);
  return new Store(root);
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const CONFIG: HarnessConfig = {
  ...DEFAULT_CONFIG,
  generator: 'claude',
  target: { repo: '.', graders: { unit_tests: 'vitest run' } },
};

const contract = {
  productGoal: 'g', userStory: 'u', scope: { include: [], exclude: [] },
  acceptanceCriteria: [
    { id: 'AC-1', severity: 'blocker' as const, behavior: 'b', verification: { method: 'unit_test' as const, expected: ['x'] } },
  ],
  redLines: [],
};

function seedIssue(store: Store, id: string, status: string, assignedAgent: string | null = null): void {
  store.addIssue(
    Issue.parse({
      id, type: 'harness', title: `t-${id}`, area: 'harness', status,
      assignedAgent, contract, createdAt: nowISO(), updatedAt: nowISO(),
    }),
  );
}

function seedTask(store: Store, id: string, target: string | null): void {
  store.addEvalTask(
    EvalTask.parse({
      id, sourceIssueId: null, featureArea: 'harness', userGoal: 'g',
      graders: ['unit_test'], severity: 'blocker', target,
      ...(target ? { graderCommands: { unit_test: 'vitest run' } } : {}),
      createdAt: nowISO(),
    }),
  );
}

function seedRegRun(store: Store, taskId: string, result: 'pass' | 'fail' | 'unverified'): void {
  store.addRegressionRun(
    RegressionRun.parse({
      id: `REGRUN-${store.db.regressionRuns.length + 1}`, taskId, target: '.',
      result, createdAt: nowISO(),
    }),
  );
}

/** All-quiet metrics (every threshold healthy) + overrides, to trip exactly one Analyst rule. */
function metricsWith(overrides: Partial<Metrics>): Metrics {
  return {
    totals: { epics: 0, issues: 1, issuesRun: 1, released: 1, samples: 2, evalRuns: 2 },
    passAt1: 1, passAtK: 1, passHatK: 1, headlineK: 2, repairSuccessRate: 1, prPassRate: 1,
    avgRepairAttempts: 1, instabilityRate: 0, cost: { usd: 0, tokens: 0, seconds: 0 },
    falsePassRate: 0, falseFailRate: 0, graderAgreement: 1, regressionCaptureRate: 1,
    regressionExecutedRate: 1, regressionFailingTasks: 0, regressionUnverifiedTasks: 0,
    interventionsPerIssue: 0, howNonInterventionRate: 1,
    lastTurnPeakConcurrency: null, lastTurnIssuesDriven: null, lastTurnCap: null,
    falsePassTrend: [], passCurve: [], byAgent: [],
    heatmap: { areas: [], types: [], counts: {}, max: 0 }, issues: [],
    ...overrides,
  };
}

/** A canned vitest report so no real grader process runs. */
function runner(assertions: { name: string; passed: boolean }[]): RegressReportRunner {
  return () => ({
    success: assertions.every((a) => a.passed),
    total: assertions.length,
    passed: assertions.filter((a) => a.passed).length,
    failedNames: assertions.filter((a) => !a.passed).map((a) => a.name),
    assertions,
  });
}

const passAt1Rule = <T extends { title: string }>(s: T[]): T[] => s.filter((x) => /first-attempt success/i.test(x.title));
const r3Rule = <T extends { title: string }>(s: T[]): T[] => s.filter((x) => /registry hygiene/i.test(x.title));

describe('decline organ — closeIssue (LIFE-A)', () => {
  it('ISSUE-0012/AC-LIFE-001 declines a non-terminal issue with a reason into a terminal closed state, audited from the store alone', () => {
    const store = freshStore();
    seedIssue(store, 'ISSUE-A', 'contract-drafted', 'claude');
    seedIssue(store, 'ISSUE-B', 'needs-human-review');
    expect(pollable(store, CONFIG).map((i) => i.id)).toContain('ISSUE-A'); // drivable before

    closeIssue(store, { issueId: 'ISSUE-A', reason: 'premise vanished at current instrument values' });
    closeIssue(store, { issueId: 'ISSUE-B', reason: 'superseded by FEAT-005' }); // any non-terminal status declines

    // Audit from a REOPENED store: the decline is a persisted fact, not process memory.
    const reopened = new Store(store.root);
    const closed = reopened.getIssue('ISSUE-A')!;
    expect(closed.status).toBe('closed'); // terminal decline state
    expect(closed.closedReason).toContain('premise vanished'); // reason auditable
    expect(closed.closedAt).toBeTruthy(); // with its time
    expect(reopened.getIssue('ISSUE-B')!.status).toBe('closed');

    // Never drivable again: the guard, adopt and assign all refuse it.
    expect(pollable(reopened, CONFIG).map((i) => i.id)).not.toContain('ISSUE-A');
    expect(() => adoptIssue(reopened, CONFIG, 'ISSUE-A')).toThrow(/closed/);
    expect(() => assignIssue(reopened, CONFIG, 'ISSUE-A')).toThrow(/closed/);
  });

  it('ISSUE-0012/AC-LIFE-001 rejects loudly — missing reason, unknown issue, released history, double decline — and persists nothing', () => {
    const store = freshStore();
    seedIssue(store, 'ISSUE-A', 'planned');
    seedIssue(store, 'ISSUE-R', 'released');

    expect(() => closeIssue(store, { issueId: 'ISSUE-A', reason: '' })).toThrow(/reason/i);
    expect(() => closeIssue(store, { issueId: 'ISSUE-A', reason: '   ' })).toThrow(/reason/i);
    expect(() => closeIssue(store, { issueId: 'ISSUE-NOPE', reason: 'r' })).toThrow(/ISSUE-NOPE/);
    expect(() => closeIssue(store, { issueId: 'ISSUE-R', reason: 'r' })).toThrow(/released/); // history is immutable

    closeIssue(store, { issueId: 'ISSUE-A', reason: 'declined once' });
    expect(() => closeIssue(store, { issueId: 'ISSUE-A', reason: 'declined twice' })).toThrow(/closed/); // already terminal

    const reopened = new Store(store.root);
    expect(reopened.getIssue('ISSUE-R')!.status).toBe('released'); // untouched
    expect(reopened.getIssue('ISSUE-A')!.closedReason).toBe('declined once'); // the rejection persisted nothing
  });
});

describe('retire organ — retireEvalTask (LIFE-B)', () => {
  it('ISSUE-0012/AC-LIFE-002 a retired task is never executed and is reported as retired; executed/unverified accounting excludes it while capture history stays', () => {
    const store = freshStore();
    // A captured blocker failure (curator id convention) so captureRate is measurable.
    seedIssue(store, 'ISSUE-0001', 'changes-requested', 'claude');
    store.addEvalRun(
      EvalRun.parse({
        id: 'EVAL-1', issueId: 'ISSUE-0001', prId: 'PR-1', attempt: 1, sampleIndex: 0,
        agent: 'claude', verdict: 'request_changes',
        findings: [{ criterionId: 'AC-1', severity: 'blocker', expected: 'x', observed: 'y' }],
        scores: { functionality: 0, codeQuality: 0, testQuality: 0, ux: 0, accessibility: 0 },
        overall: 0.3, cost: {}, createdAt: nowISO(),
      }),
    );
    seedTask(store, 'EVAL-TASK-ISSUE-0001-AC-1', '.'); // captures the failure; executed pass
    seedRegRun(store, 'EVAL-TASK-ISSUE-0001-AC-1', 'pass');
    seedTask(store, 'EVAL-TASK-ISSUE-0002-AC-1', '.'); // executed but unverified
    seedRegRun(store, 'EVAL-TASK-ISSUE-0002-AC-1', 'unverified');
    seedTask(store, 'EVAL-TASK-ISSUE-0003-AC-1', '.'); // never executed

    const before = computeMetrics(store);
    expect(before.regressionCaptureRate).toBe(1);
    expect(before.regressionExecutedRate).toBeCloseTo(2 / 3, 5);
    expect(before.regressionUnverifiedTasks).toBe(1);

    retireEvalTask(store, { taskId: 'EVAL-TASK-ISSUE-0002-AC-1', reason: 'volatile sandbox residue — no guard value' });
    retireEvalTask(store, { taskId: 'EVAL-TASK-ISSUE-0003-AC-1', reason: 'volatile sandbox residue — no guard value' });

    // Never executed again, but never silent either: no RegressionRun, reported as retired.
    const runsBefore = store.db.regressionRuns.length;
    const res = runRegressionTasks(store, CONFIG, {
      report: runner([{ name: 'ISSUE-0001/AC-1 holds', passed: true }]),
    });
    expect(res.results.map((r) => r.taskId)).toEqual(['EVAL-TASK-ISSUE-0001-AC-1']);
    expect(store.db.regressionRuns.length).toBe(runsBefore + 1); // no run recorded for retired tasks
    const retiredReports = res.skipped.filter((s) => /retired/i.test(s.reason));
    expect(retiredReports.map((s) => s.taskId).sort()).toEqual(['EVAL-TASK-ISSUE-0002-AC-1', 'EVAL-TASK-ISSUE-0003-AC-1']);
    expect(retiredReports[0]!.reason).toContain('no guard value'); // the WHY travels with the report

    const after = computeMetrics(store);
    expect(after.regressionExecutedRate).toBe(1); // 1/1 active
    expect(after.regressionUnverifiedTasks).toBe(0); // retired excluded from the aggregation
    expect(after.regressionCaptureRate).toBe(1); // capture history untouched

    // A retirement is a state, not an erasure: records and their reasons survive a reopen.
    const reopened = new Store(store.root);
    expect(reopened.db.evalTasks).toHaveLength(3);
    const retired = reopened.db.evalTasks.find((t) => t.id === 'EVAL-TASK-ISSUE-0002-AC-1')!;
    expect(retired.retiredReason).toContain('no guard value');
    expect(retired.retiredAt).toBeTruthy();

    // Final step: retire the CAPTURING task itself. The captured pair 'ISSUE-0001 AC-1'
    // must stay captured — capture rate sees retired tasks (history, not erasure), so an
    // implementation that drops retired tasks from the capture set would read 0 here.
    retireEvalTask(store, { taskId: 'EVAL-TASK-ISSUE-0001-AC-1', reason: 'superseded — covered by a broader suite' });
    expect(computeMetrics(store).regressionCaptureRate).toBe(1);
  });

  it('ISSUE-0012/AC-LIFE-002 rejects loudly — missing reason, unknown task, double retire', () => {
    const store = freshStore();
    seedTask(store, 'EVAL-TASK-ISSUE-0001-AC-1', '.');
    expect(() => retireEvalTask(store, { taskId: 'EVAL-TASK-ISSUE-0001-AC-1', reason: '  ' })).toThrow(/reason/i);
    expect(() => retireEvalTask(store, { taskId: 'EVAL-TASK-NOPE', reason: 'r' })).toThrow(/EVAL-TASK-NOPE/);
    retireEvalTask(store, { taskId: 'EVAL-TASK-ISSUE-0001-AC-1', reason: 'r' });
    expect(() => retireEvalTask(store, { taskId: 'EVAL-TASK-ISSUE-0001-AC-1', reason: 'again' })).toThrow(/retired/);
  });
});

describe('Analyst rule-identity dedup (LIFE-C)', () => {
  it('ISSUE-0012/AC-LIFE-003 a rule re-firing with a different metric value collapses into its open issue; a terminal issue never silences re-filing', () => {
    const store = freshStore();
    const openIssues = () => store.db.issues.filter((i) => /first-attempt success/i.test(i.title));

    // Same rule, different baked-in values → different title text: still ONE open item.
    createSuggestionIssues(store, passAt1Rule(analyzeHarness(store, metricsWith({ passAt1: 0.4 }))));
    expect(openIssues()).toHaveLength(1);
    createSuggestionIssues(store, passAt1Rule(analyzeHarness(store, metricsWith({ passAt1: 0.3 }))));
    expect(openIssues()).toHaveLength(1); // collapsed into the open inventory item

    // Terminal (closed) must not suppress: the rule re-files with fresh evidence.
    closeIssue(store, { issueId: openIssues()[0]!.id, reason: 'investigated — premise gone at current values' });
    createSuggestionIssues(store, passAt1Rule(analyzeHarness(store, metricsWith({ passAt1: 0.3 }))));
    expect(openIssues()).toHaveLength(2); // even at the SAME value the closed one matched

    // ...and released must not suppress either (the fix may regress with new evidence).
    // Walk the machine's legal path: the always-allowed escape hatch, then the review
    // gate's needs-human-review → released edge (→ released is never a jump).
    const second = openIssues().find((i) => i.status !== 'closed')!;
    store.setStatus(second.id, 'needs-human-review');
    store.setStatus(second.id, 'released');
    createSuggestionIssues(store, passAt1Rule(analyzeHarness(store, metricsWith({ passAt1: 0.2 }))));
    expect(openIssues()).toHaveLength(3);
  });

  it('ISSUE-0012/AC-LIFE-003 suggestions without a rule id keep the legacy title dedup (additive compatibility)', () => {
    const store = freshStore();
    const sug = { type: 'harness' as const, area: 'harness' as const, title: 'Hand-rolled proposal', rationale: 'r' };
    expect(createSuggestionIssues(store, [sug])).toHaveLength(1);
    expect(createSuggestionIssues(store, [sug])).toHaveLength(0); // same title → deduped as before
  });

  it('ISSUE-0012/AC-LIFE-004 R3 (registry hygiene) ignores retired tasks: all-retired premise stays quiet, one active offender still fires', () => {
    const store = freshStore();
    seedTask(store, 'EVAL-TASK-ISSUE-0001-AC-1', null); // unbound → R3 offender
    seedTask(store, 'EVAL-TASK-ISSUE-0001-AC-2', '.'); // unverified → R3 offender
    seedRegRun(store, 'EVAL-TASK-ISSUE-0001-AC-2', 'unverified');
    expect(r3Rule(analyzeHarness(store, metricsWith({})))).toHaveLength(1); // fires while active

    retireEvalTask(store, { taskId: 'EVAL-TASK-ISSUE-0001-AC-1', reason: 'volatile sandbox residue' });
    expect(r3Rule(analyzeHarness(store, metricsWith({})))).toHaveLength(1); // one offender left → still fires

    retireEvalTask(store, { taskId: 'EVAL-TASK-ISSUE-0001-AC-2', reason: 'volatile sandbox residue' });
    expect(r3Rule(analyzeHarness(store, metricsWith({})))).toHaveLength(0); // ⑧ applied → R3 stops
  });
});
