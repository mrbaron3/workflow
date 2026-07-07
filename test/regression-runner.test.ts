/**
 * The regression EXECUTOR — the second half of the steering star ("never repeat the same
 * failure twice"): the Curator captures failures into the Eval Task Registry; this runs
 * them. v0 (ADR-0007 帰結): re-run the target's unit_tests grader once and match assertion
 * names against each task's AC id (the same convention groundArtifact's `satisfied` uses).
 *
 * Grounded constraint this design answers (2026-07-07): the registry mixes tasks from
 * DIFFERENT target repos (sandbox roman vs self-hosted harness) and AC ids collide across
 * issues (both have AC-1) — so tasks are BOUND to a repo at curation time (EvalTask.target)
 * and the executor only runs tasks bound to the current config.target, reporting the rest
 * as skipped. A task whose AC id matches no assertion is 'unverified', never a silent pass.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, nowISO } from '../src/store/store.js';
import { Issue, EvalRun, EvalTask, RegressionRun } from '../src/domain/schema.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import { curateEvalTasks } from '../src/pipeline/curator.js';
import { runRegressionTasks, type RegressReportRunner } from '../src/pipeline/regression.js';
import { improveTick } from '../src/pipeline/improve.js';
import { computeMetrics } from '../src/metrics/metrics.js';

const dirs: string[] = [];
function freshStore(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-regress-'));
  dirs.push(root);
  return new Store(root);
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const CONFIG: HarnessConfig = {
  ...DEFAULT_CONFIG,
  generator: 'claude',
  target: { repo: '.', graders: { unit_tests: 'vitest run' } },
};

function seedIssueWithRun(store: Store, id = 'ISSUE-0001'): Issue {
  const issue = store.addIssue(
    Issue.parse({
      id, type: 'harness', title: 't', area: 'harness', status: 'contract-drafted',
      assignedAgent: 'claude', epicId: null, sprint: null, createdAt: nowISO(), updatedAt: nowISO(),
      contract: {
        productGoal: 'g', userStory: 'u', scope: { include: ['src/**'], exclude: [] },
        acceptanceCriteria: [
          { id: 'AC-1', severity: 'blocker', behavior: 'b1', verification: { method: 'unit_test', expected: ['x'] } },
        ],
        redLines: [],
      },
    }),
  );
  store.addEvalRun(
    EvalRun.parse({
      id: `EVAL-${store.db.evalRuns.length + 1}`, issueId: id, prId: 'PR-1', attempt: 1, sampleIndex: 0,
      agent: 'claude', verdict: 'request_changes',
      findings: [{ criterionId: 'AC-1', severity: 'blocker', expected: 'x', observed: 'y' }],
      scores: { functionality: 0, codeQuality: 0, testQuality: 0, ux: 0, accessibility: 0 },
      overall: 0.3, cost: {}, createdAt: nowISO(),
    }),
  );
  return issue;
}

/** A canned vitest report the executor consumes instead of really running vitest. */
function runner(assertions: { name: string; passed: boolean }[]): RegressReportRunner {
  return () => ({
    success: assertions.every((a) => a.passed),
    total: assertions.length,
    passed: assertions.filter((a) => a.passed).length,
    failedNames: assertions.filter((a) => !a.passed).map((a) => a.name),
    assertions,
  });
}

describe('curator binds tasks to the target repo (EvalTask.target)', () => {
  it('stamps config.target.repo at curation time; null without a config', () => {
    const store = freshStore();
    seedIssueWithRun(store);
    const { created } = curateEvalTasks(store, CONFIG);
    expect(created.length).toBeGreaterThan(0);
    expect(created.every((t) => t.target === '.')).toBe(true);

    const store2 = freshStore();
    seedIssueWithRun(store2);
    expect(curateEvalTasks(store2).created.every((t) => t.target === null)).toBe(true); // legacy shape
  });
});

describe('runRegressionTasks — executes bound tasks, never silently passes', () => {
  it('pass / fail / unverified by AC-id assertion match, persisted as RegressionRuns', () => {
    const store = freshStore();
    const mk = (issueId: string, ac: string): EvalTask =>
      store.addEvalTask(EvalTask.parse({
        id: `EVAL-TASK-${issueId}-${ac}`, sourceIssueId: issueId, featureArea: 'harness',
        userGoal: 'g', graders: ['unit_test'], severity: 'blocker', createdAt: nowISO(), target: '.',
      }));
    mk('ISSUE-0001', 'AC-1'); // will pass
    mk('ISSUE-0001', 'AC-2'); // will fail
    mk('ISSUE-0001', 'AC-3'); // no matching assertion -> unverified

    const res = runRegressionTasks(store, CONFIG, {
      report: runner([
        { name: 'suite AC-1 does the thing', passed: true },
        { name: 'suite AC-2 stays clean', passed: false },
      ]),
    });

    const by = (ac: string) => res.results.find((r) => r.taskId.endsWith(ac))!;
    expect(by('AC-1').result).toBe('pass');
    expect(by('AC-2').result).toBe('fail');
    expect(by('AC-2').failedNames).toContain('suite AC-2 stays clean');
    expect(by('AC-3').result).toBe('unverified'); // zero matches is NOT a pass
    expect(store.db.regressionRuns.length).toBe(3); // durable in the store (ADR-0001)
    expect(store.db.regressionRuns.every((r) => r.target === '.')).toBe(true);
  });

  it('skips (and reports) tasks bound to another repo or unbound legacy tasks', () => {
    const store = freshStore();
    store.addEvalTask(EvalTask.parse({
      id: 'EVAL-TASK-ISSUE-0009-AC-1', sourceIssueId: 'ISSUE-0009', featureArea: 'backend',
      userGoal: 'g', graders: ['unit_test'], severity: 'blocker', createdAt: nowISO(),
      target: '.harness/sandbox', // bound elsewhere
    }));
    store.addEvalTask(EvalTask.parse({
      id: 'EVAL-TASK-ISSUE-0010-AC-1', sourceIssueId: 'ISSUE-0010', featureArea: 'backend',
      userGoal: 'g', graders: ['unit_test'], severity: 'blocker', createdAt: nowISO(), // target: null
    }));

    const res = runRegressionTasks(store, CONFIG, { report: runner([]) });
    expect(res.results).toEqual([]);
    expect(res.skipped.map((s) => s.taskId).sort()).toEqual(['EVAL-TASK-ISSUE-0009-AC-1', 'EVAL-TASK-ISSUE-0010-AC-1']);
    expect(store.db.regressionRuns).toEqual([]); // nothing executed, nothing fabricated
  });

  it('does nothing without a configured unit_tests grader (reported, not silent)', () => {
    const store = freshStore();
    store.addEvalTask(EvalTask.parse({
      id: 'EVAL-TASK-ISSUE-0001-AC-1', sourceIssueId: 'ISSUE-0001', featureArea: 'harness',
      userGoal: 'g', graders: ['unit_test'], severity: 'blocker', createdAt: nowISO(), target: '.',
    }));
    const bare: HarnessConfig = { ...DEFAULT_CONFIG, target: { repo: '.' } };
    const res = runRegressionTasks(store, bare, { report: runner([{ name: 'AC-1', passed: true }]) });
    expect(res.results).toEqual([]);
    expect(res.skipped.length).toBe(1);
  });
});

describe('③ instrument: regression execution sits next to capture', () => {
  it('regressionExecutedRate / failing / unverified derive from the latest run per task', () => {
    const store = freshStore();
    seedIssueWithRun(store);
    curateEvalTasks(store, CONFIG); // 1 blocker AC -> 1 task, bound to '.'
    expect(computeMetrics(store).regressionExecutedRate).toBe(0); // registry alive, nothing executed

    // first execution: fail; second execution: pass — the LATEST run wins
    runRegressionTasks(store, CONFIG, { report: runner([{ name: 'x AC-1 y', passed: false }]) });
    expect(computeMetrics(store).regressionFailingTasks).toBe(1);
    runRegressionTasks(store, CONFIG, { report: runner([{ name: 'x AC-1 y', passed: true }]) });

    const m = computeMetrics(store);
    expect(m.regressionExecutedRate).toBe(1);
    expect(m.regressionFailingTasks).toBe(0);
    expect(m.regressionUnverifiedTasks).toBe(0);
  });

  it('rate is null with an empty registry (nothing to execute yet)', () => {
    expect(computeMetrics(freshStore()).regressionExecutedRate).toBeNull();
  });
});

describe('improveTick runs the executor when given a config (live-turn tail)', () => {
  it('with config: curates AND executes; without: curates only (backward compatible)', () => {
    const store = freshStore();
    seedIssueWithRun(store);
    const lines: string[] = [];
    const res = improveTick(store, (m) => lines.push(m), {
      config: CONFIG,
      regressReport: runner([{ name: 'z AC-1', passed: true }]),
    });
    expect(res.curated.length).toBeGreaterThan(0);
    expect(res.curated.every((t) => t.target === '.')).toBe(true); // config reaches the curator
    expect(store.db.regressionRuns.length).toBe(res.curated.length); // freshly curated tasks executed
    expect(lines.some((l) => l.includes('regression'))).toBe(true);

    const store2 = freshStore();
    seedIssueWithRun(store2);
    improveTick(store2); // legacy call shape
    expect(store2.db.regressionRuns).toEqual([]);
  });
});

describe('schema: RegressionRun is additive (old dbs parse; new rows round-trip)', () => {
  it('round-trips through save/load', () => {
    const store = freshStore();
    store.db.regressionRuns.push(RegressionRun.parse({
      id: 'REGRUN-0001', taskId: 'EVAL-TASK-ISSUE-0001-AC-1', target: '.',
      result: 'fail', matchedAssertions: 2, failedNames: ['a'], createdAt: nowISO(),
    }));
    store.save();
    const reloaded = new Store(store.root);
    expect(reloaded.db.regressionRuns[0]!.result).toBe('fail');
  });
});
