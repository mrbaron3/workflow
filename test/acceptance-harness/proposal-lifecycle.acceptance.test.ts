/**
 * Env-gated acceptance grader for ISSUE-0012 "Add decline/retire organs and rule-identity
 * analyst dedup" — spec docs/specs/proposal-lifecycle-decline-organ-and-analyst-dedup-hygiene
 * (AC-LIFE-001..004).
 *
 * This began as the env-gated acceptance grader for the drive — red at baseline BY DESIGN,
 * collected only under ACCEPT_HARNESS=1 (ADR-0007 I3). The build was human-approved and
 * released (2026-07-08, one repair round; five persisted-attested findings remained, all
 * behavior-preserving refactor/test pins). All five were made RELEASE CONDITIONS in the
 * same closure (⑥'s conditional-approval pattern, recorded via `agentops intervene`):
 * Store.updateEvalTask encapsulation, the shared active/retired predicate and task-id
 * convention (src/domain/eval-task.ts), the declineIssue/closeIssue vocabulary alias, and
 * the store-level history-immutability pin below. skipIf dropped: permanent guard.
 *
 * Gate-condition pin (⑩, testQuality persisted major): Store.setStatus's terminal-entry
 * carve-out has two halves; the reject half ("nothing already terminal can be
 * re-terminalized") had NO test — a mutant dropping it passed all 344 tests. Pinned below.
 *
 * Semantics this file pins (spec is the SoT):
 *   - decline/retire are human JUDGMENT POINTS — the closing/retiring organ is explicit,
 *     never automatic, and NOT an intervention (FEAT-004's vocabulary stays judgment-free).
 *   - Retirement is a STATE, not an erasure: records survive, capture history is untouched
 *     (captureRate must not move when a task retires) — only execution and the
 *     executed/unverified accounting exclude retired tasks.
 *   - Analyst inventory identity is the RULE, not the title text: metric values baked into
 *     titles must neither duplicate open inventory (value moved) nor let a terminal issue
 *     silence re-filing forever (value matched).
 *
 * Seams this file pins (harness-owned WHAT confirmation):
 *   - src/pipeline/lifecycle.ts exports `closeIssue(store, {issueId, reason})` and
 *     `retireEvalTask(store, {taskId, reason})` — the single mutation points; reason
 *     mandatory; unknown ids / released / already-closed rejected loudly.
 *   - Issue reaches a terminal 'closed' status: never pollable, adopt/assign reject it.
 *   - runRegressionTasks never executes a retired task and reports it as retired (not a
 *     silent skip); computeMetrics excludes retired tasks from regressionExecutedRate and
 *     regressionUnverifiedTasks while regressionCaptureRate is unchanged.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, nowISO } from '../../src/store/store.js';
import { EvalRun, EvalTask, Issue, RegressionRun } from '../../src/domain/schema.js';
import { computeMetrics, type Metrics } from '../../src/metrics/metrics.js';
import { analyzeHarness, createSuggestionIssues } from '../../src/pipeline/analyst.js';
import { runRegressionTasks, type RegressReportRunner } from '../../src/pipeline/regression.js';
import { pollable } from '../../src/pipeline/execution/guard.js';
import { adoptIssue } from '../../src/pipeline/adopt.js';
import { assignIssue } from '../../src/pipeline/assign.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../../src/config.js';

// Computed-specifier lazy dynamic import (⑨ convention): the module does not exist at
// baseline (that IS the red); a literal specifier would break the repo-wide tsc gate.
async function seam(): Promise<Record<string, unknown>> {
  const spec = '../../src/pipeline/' + 'lifecycle.js';
  return (await import(spec)) as Record<string, unknown>;
}
type Closer = (store: Store, input: { issueId: string; reason: string }) => unknown;
type Retirer = (store: Store, input: { taskId: string; reason: string }) => unknown;

const dirs: string[] = [];
function freshStore(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-life-'));
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

/** All-quiet metrics (every threshold healthy, all REQUIRED fields present) + overrides. */
function metricsWith(overrides: Partial<Metrics>): Metrics {
  return {
    totals: { epics: 0, issues: 1, issuesRun: 1, released: 1, samples: 2, evalRuns: 2 },
    passAt1: 1, passAtK: 1, passHatK: 1, headlineK: 2, repairSuccessRate: 1, prPassRate: 1,
    avgRepairAttempts: 1, instabilityRate: 0, cost: { usd: 0, tokens: 0, seconds: 0 },
    falsePassRate: 0, falseFailRate: 0, graderAgreement: 1, humanDecisionCount: 10,
    regressionCaptureRate: 1,
    regressionExecutedRate: 1, regressionFailingTasks: 0, regressionUnverifiedTasks: 0,
    interventionsPerIssue: 0, howNonInterventionRate: 1,
    lastTurnPeakConcurrency: null, lastTurnIssuesDriven: null, lastTurnCap: null,
    falsePassTrend: [], passCurve: [], byAgent: [], byInvocationProvider: [],
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

describe('proposal lifecycle — decline/retire organs and rule-identity dedup (ISSUE-0012)', () => {
  it('ISSUE-0012/AC-LIFE-001 gate condition: setStatus can never re-terminalize history (released↛closed, closed↛released), while one-step terminal entry stays legal', async () => {
    const { closeIssue } = await seam();
    const store = freshStore();

    seedIssue(store, 'ISSUE-R', 'released');
    expect(() => store.setStatus('ISSUE-R', 'closed')).toThrow(/[Ii]llegal|released/);

    seedIssue(store, 'ISSUE-C', 'planned');
    (closeIssue as Closer)(store, { issueId: 'ISSUE-C', reason: 'r' });
    expect(() => store.setStatus('ISSUE-C', 'released')).toThrow(/[Ii]llegal|closed/);

    // The positive half of the carve-out: non-terminal → terminal in one step is the
    // decline organ's only entrance and the release path's shortcut — must stay legal.
    seedIssue(store, 'ISSUE-N', 'needs-human-review');
    expect(store.setStatus('ISSUE-N', 'released').status).toBe('released');
  });

  it('ISSUE-0012/AC-LIFE-001 a non-terminal issue declines with a reason into a terminal closed state: audited, never pollable, adopt/assign reject it', async () => {
    const { closeIssue } = await seam();
    const close = closeIssue as Closer;

    const store = freshStore();
    seedIssue(store, 'ISSUE-A', 'contract-drafted', 'claude');
    expect(pollable(store, CONFIG).map((i) => i.id)).toContain('ISSUE-A'); // drivable before

    close(store, { issueId: 'ISSUE-A', reason: 'premise vanished at current instrument values' });

    const reopened = new Store(store.root);
    const closed = reopened.getIssue('ISSUE-A')!;
    expect(closed.status).toBe('closed'); // terminal decline state
    expect(JSON.stringify(closed)).toContain('premise vanished'); // reason auditable from the store alone
    expect(pollable(reopened, CONFIG).map((i) => i.id)).not.toContain('ISSUE-A'); // never drivable again
    expect(() => adoptIssue(reopened, CONFIG, 'ISSUE-A')).toThrow();
    expect(() => assignIssue(reopened, CONFIG, 'ISSUE-A')).toThrow();
  });

  it('ISSUE-0012/AC-LIFE-001 decline rejects loudly: missing reason, unknown issue, released history, double close — nothing persisted', async () => {
    const { closeIssue } = await seam();
    const close = closeIssue as Closer;

    const store = freshStore();
    seedIssue(store, 'ISSUE-A', 'planned');
    seedIssue(store, 'ISSUE-R', 'released');

    expect(() => close(store, { issueId: 'ISSUE-A', reason: '' })).toThrow(/reason/i);
    expect(() => close(store, { issueId: 'ISSUE-NOPE', reason: 'r' })).toThrow(/ISSUE-NOPE/);
    expect(() => close(store, { issueId: 'ISSUE-R', reason: 'r' })).toThrow(); // history is immutable

    close(store, { issueId: 'ISSUE-A', reason: 'declined once' });
    expect(() => close(store, { issueId: 'ISSUE-A', reason: 'declined twice' })).toThrow(); // already terminal

    const reopened = new Store(store.root);
    expect(reopened.getIssue('ISSUE-R')!.status).toBe('released'); // untouched
    expect(JSON.stringify(reopened.getIssue('ISSUE-A'))).not.toContain('declined twice');
  });

  it('ISSUE-0012/AC-LIFE-002 a retired task is never executed and is reported as retired; executed/unverified accounting excludes it while capture history stays', async () => {
    const { retireEvalTask } = await seam();
    const retire = retireEvalTask as Retirer;

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
    seedTask(store, 'EVAL-TASK-ISSUE-0002-AC-1', '.'); // executed but unverified (roman shape)
    seedRegRun(store, 'EVAL-TASK-ISSUE-0002-AC-1', 'unverified');
    seedTask(store, 'EVAL-TASK-ISSUE-0003-AC-1', '.'); // never executed

    const before = computeMetrics(store);
    expect(before.regressionCaptureRate).toBe(1);
    expect(before.regressionExecutedRate).toBeCloseTo(2 / 3, 5);
    expect(before.regressionUnverifiedTasks).toBe(1);

    retire(store, { taskId: 'EVAL-TASK-ISSUE-0002-AC-1', reason: 'volatile sandbox residue — no guard value' });
    retire(store, { taskId: 'EVAL-TASK-ISSUE-0003-AC-1', reason: 'volatile sandbox residue — no guard value' });

    // Never executed again, but never silent either: the run reports it as retired.
    const res = runRegressionTasks(store, CONFIG, {
      report: runner([{ name: 'ISSUE-0001/AC-1 holds', passed: true }]),
    });
    expect(res.results.map((r) => r.taskId)).toEqual(['EVAL-TASK-ISSUE-0001-AC-1']);
    expect(JSON.stringify(res)).toMatch(/retired/i);

    const after = computeMetrics(store);
    expect(after.regressionExecutedRate).toBe(1); // 1/1 active
    expect(after.regressionUnverifiedTasks).toBe(0); // retired excluded
    expect(after.regressionCaptureRate).toBe(1); // capture history untouched
    // A retirement is a state, not an erasure: the records and their reasons survive.
    const reopened = new Store(store.root);
    expect(reopened.db.evalTasks).toHaveLength(3);
    expect(JSON.stringify(reopened.db.evalTasks)).toContain('no guard value');
  });

  it('ISSUE-0012/AC-LIFE-002 retire rejects loudly: missing reason, unknown task', async () => {
    const { retireEvalTask } = await seam();
    const retire = retireEvalTask as Retirer;
    const store = freshStore();
    seedTask(store, 'EVAL-TASK-ISSUE-0001-AC-1', '.');
    expect(() => retire(store, { taskId: 'EVAL-TASK-ISSUE-0001-AC-1', reason: '  ' })).toThrow(/reason/i);
    expect(() => retire(store, { taskId: 'EVAL-TASK-NOPE', reason: 'r' })).toThrow(/EVAL-TASK-NOPE/);
  });

  it('ISSUE-0012/AC-LIFE-003 a rule re-firing with a different metric value collapses into its open issue; a terminal issue never silences re-filing', async () => {
    const { closeIssue } = await seam();
    const close = closeIssue as Closer;

    const store = freshStore();
    // Same rule, different baked-in values → different title text.
    createSuggestionIssues(store, passAt1Rule(analyzeHarness(store, metricsWith({ passAt1: 0.4 }))));
    const openIssues = () => store.db.issues.filter((i) => /first-attempt success/i.test(i.title));
    expect(openIssues()).toHaveLength(1);

    createSuggestionIssues(store, passAt1Rule(analyzeHarness(store, metricsWith({ passAt1: 0.3 }))));
    expect(openIssues()).toHaveLength(1); // collapsed into the open inventory item — no duplicate

    // Terminal (closed) must not suppress: the rule re-files with fresh evidence.
    close(store, { issueId: openIssues()[0]!.id, reason: 'investigated — premise gone at current values' });
    createSuggestionIssues(store, passAt1Rule(analyzeHarness(store, metricsWith({ passAt1: 0.3 }))));
    expect(openIssues()).toHaveLength(2); // information is never lost

    // ...and released must not suppress either (the fix may regress with new evidence).
    // ('closed' is not in IssueStatus at baseline — the string cast keeps baseline tsc green.)
    const second = openIssues().find((i) => (i.status as string) !== 'closed')!;
    store.setStatus(second.id, 'released');
    createSuggestionIssues(store, passAt1Rule(analyzeHarness(store, metricsWith({ passAt1: 0.2 }))));
    expect(openIssues()).toHaveLength(3);
  });

  it('ISSUE-0012/AC-LIFE-004 R3 (registry hygiene) ignores retired tasks: all-retired premise stays quiet, one active offender still fires', async () => {
    const { retireEvalTask } = await seam();
    const retire = retireEvalTask as Retirer;

    const store = freshStore();
    seedTask(store, 'EVAL-TASK-ISSUE-0001-AC-1', null); // unbound → R3 offender
    seedTask(store, 'EVAL-TASK-ISSUE-0001-AC-2', '.'); // unverified → R3 offender
    seedRegRun(store, 'EVAL-TASK-ISSUE-0001-AC-2', 'unverified');
    expect(r3Rule(analyzeHarness(store, metricsWith({})))).toHaveLength(1); // fires while active

    retire(store, { taskId: 'EVAL-TASK-ISSUE-0001-AC-1', reason: 'volatile sandbox residue' });
    expect(r3Rule(analyzeHarness(store, metricsWith({})))).toHaveLength(1); // one offender left → still fires

    retire(store, { taskId: 'EVAL-TASK-ISSUE-0001-AC-2', reason: 'volatile sandbox residue' });
    expect(r3Rule(analyzeHarness(store, metricsWith({})))).toHaveLength(0); // ⑧ applied → R3 stops
  });
});
