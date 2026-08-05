/**
 * ISSUE-0005 — Bind grader commands at curate and execute regression tasks per target
 * (spec docs/specs/regression-multi-target-execution, AC-REGMT-001..004).
 *
 * The registry mixes tasks bound to DIFFERENT target repos, and config.target can be
 * repointed at any time — so a task must carry its own means of execution:
 *   - curate captures the grader command for the AC's verification method into
 *     EvalTask.graderCommands (never fabricating one that is not configured);
 *   - the executor runs each task against its OWN bound target (one shared grader run
 *     per target), falling back to config.target.graders only for command-less legacy
 *     tasks bound to the current target;
 *   - a task whose execution preconditions are missing (repo gone from disk, command
 *     unknown) is skipped WITH a reason naming that precondition — never fabricated,
 *     never silent (ARCH-execution-015 の精神).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, nowISO } from '../src/store/store.js';
import { Issue, EvalRun, EvalTask } from '../src/domain/schema.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import { curateEvalTasks } from '../src/pipeline/curator.js';
import { runRegressionTasks, type RegressReportRunner } from '../src/pipeline/regression.js';
import type { VitestReport } from '../src/pipeline/execution/grade.js';

const dirs: string[] = [];
function freshStore(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-regmt-unit-'));
  dirs.push(root);
  return new Store(root);
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function cfg(repo: string, graders?: { typecheck?: string; unit_tests?: string }): HarnessConfig {
  return {
    ...DEFAULT_CONFIG,
    generator: 'claude',
    target: { repo, ...(graders ? { graders } : {}) },
  };
}

/** An issue with one blocker AC (given method) plus one graded run, so curate promotes it. */
function seedIssueWithRun(store: Store, id: string, method: 'unit_test' | 'typecheck' = 'unit_test'): void {
  store.addIssue(
    Issue.parse({
      id, type: 'story', title: 't', area: 'backend', status: 'contract-drafted',
      assignedAgent: 'claude', createdAt: nowISO(), updatedAt: nowISO(),
      contract: {
        productGoal: 'g', userStory: 'u', scope: { include: [], exclude: [] },
        acceptanceCriteria: [
          { id: 'AC-1', severity: 'blocker', behavior: 'b', verification: { method, expected: ['x'] } },
        ],
        redLines: [],
      },
    }),
  );
  store.addEvalRun(
    EvalRun.parse({
      id: `EVAL-${store.db.evalRuns.length + 1}`, issueId: id, prId: 'PR-1', attempt: 1, sampleIndex: 0,
      agent: 'claude', verdict: 'approve', findings: [],
      scores: { functionality: 0, codeQuality: 0, testQuality: 0, ux: 0, accessibility: 0 },
      overall: 1, cost: {}, createdAt: nowISO(),
    }),
  );
}

/** A registry task as curate would bind it; `commands` = captured grader commands (or legacy). */
function boundTask(
  store: Store,
  issueId: string,
  acId: string,
  target: string,
  commands?: Record<string, string>,
): EvalTask {
  return store.addEvalTask(
    EvalTask.parse({
      id: `EVAL-TASK-${issueId}-${acId}`, sourceIssueId: issueId, featureArea: 'backend',
      userGoal: 'g', expected: ['x'], graders: ['unit_test'], severity: 'blocker',
      target, ...(commands ? { graderCommands: commands } : {}), createdAt: nowISO(),
    }),
  );
}

function fakeReport(assertions: { name: string; passed: boolean }[]): VitestReport {
  const failed = assertions.filter((a) => !a.passed);
  return {
    success: failed.length === 0, total: assertions.length,
    passed: assertions.length - failed.length, failedNames: failed.map((a) => a.name), assertions,
  };
}

describe('curate captures grader commands into the task (AC-REGMT-001)', () => {
  it('ISSUE-0005/AC-REGMT-001 the created task holds the bound target AND the command for its AC verification method', () => {
    const store = freshStore();
    seedIssueWithRun(store, 'ISSUE-A');
    const { created } = curateEvalTasks(store, cfg('target-a', { unit_tests: 'CMD-A' }));
    const task = created.find((t) => t.id === 'EVAL-TASK-ISSUE-A-AC-1')!;
    expect(task.target).toBe('target-a');
    expect(task.graderCommands?.['unit_test']).toBe('CMD-A');
  });

  it('ISSUE-0005/AC-REGMT-001 the capture survives a save/load round-trip (the task keeps its execution means)', () => {
    const store = freshStore();
    seedIssueWithRun(store, 'ISSUE-A');
    curateEvalTasks(store, cfg('target-a', { unit_tests: 'CMD-A' }));
    store.save();
    const reloaded = new Store(store.root);
    expect(reloaded.db.evalTasks[0]!.graderCommands?.['unit_test']).toBe('CMD-A');
  });

  it('ISSUE-0005/AC-REGMT-001 a method with no configured command is NOT captured (nothing fabricated)', () => {
    const store = freshStore();
    seedIssueWithRun(store, 'ISSUE-A');
    // config has a typecheck command but the AC verifies via unit_test → nothing to capture
    const { created } = curateEvalTasks(store, cfg('target-a', { typecheck: 'tsc --noEmit' }));
    const task = created.find((t) => t.id === 'EVAL-TASK-ISSUE-A-AC-1')!;
    expect(task.graderCommands?.['unit_test']).toBeUndefined();
    expect(task.graderCommands?.['typecheck']).toBeUndefined(); // not this AC's method

    const store2 = freshStore();
    seedIssueWithRun(store2, 'ISSUE-B');
    const { created: c2 } = curateEvalTasks(store2, cfg('target-a')); // no graders at all
    expect(c2[0]!.graderCommands?.['unit_test']).toBeUndefined();
  });

  it('ISSUE-0005/AC-REGMT-001 capture follows the AC method: a typecheck AC captures the typecheck command', () => {
    const store = freshStore();
    seedIssueWithRun(store, 'ISSUE-A', 'typecheck');
    const { created } = curateEvalTasks(store, cfg('target-a', { typecheck: 'tsc --noEmit', unit_tests: 'CMD-A' }));
    const task = created.find((t) => t.id === 'EVAL-TASK-ISSUE-A-AC-1')!;
    expect(task.graderCommands?.['typecheck']).toBe('tsc --noEmit');
    expect(task.graderCommands?.['unit_test']).toBeUndefined(); // not this AC's method
  });
});

describe('executor runs captured-command tasks per bound target (AC-REGMT-002)', () => {
  it('ISSUE-0005/AC-REGMT-002 a captured-command task bound to target A runs there even when config.target is B', () => {
    const store = freshStore();
    fs.mkdirSync(path.join(store.root, 'target-a'), { recursive: true });
    fs.mkdirSync(path.join(store.root, 'target-b'), { recursive: true });
    boundTask(store, 'ISSUE-A', 'AC-1', 'target-a', { unit_test: 'CMD-A' });
    boundTask(store, 'ISSUE-A', 'AC-2', 'target-a', { unit_test: 'CMD-A' });

    const calls: { cmd: string; cwd: string }[] = [];
    const { results, skipped } = runRegressionTasks(store, cfg('target-b', { unit_tests: 'CMD-B' }), {
      report: (cmd, cwd) => {
        calls.push({ cmd, cwd });
        return fakeReport([
          { name: 'ISSUE-A/AC-1 holds', passed: true },
          { name: 'ISSUE-A/AC-2 holds', passed: false },
        ]);
      },
    });

    expect(skipped).toEqual([]); // NOT skipped despite config pointing at B
    expect(calls).toHaveLength(1); // two tasks, one target → ONE shared grader run
    expect(calls[0]!.cmd).toBe('CMD-A'); // the captured command, not config's CMD-B
    expect(path.resolve(calls[0]!.cwd)).toBe(path.resolve(store.root, 'target-a'));
    expect(results.find((r) => r.taskId === 'EVAL-TASK-ISSUE-A-AC-1')!.result).toBe('pass');
    expect(results.find((r) => r.taskId === 'EVAL-TASK-ISSUE-A-AC-2')!.result).toBe('fail');
    expect(store.db.regressionRuns).toHaveLength(2); // durable (ADR-0001)
    expect(store.db.regressionRuns.every((r) => r.target === 'target-a')).toBe(true);
  });

  it('ISSUE-0005/AC-REGMT-002 grader runs never exceed the number of bound targets (mixed captured + legacy)', () => {
    const store = freshStore();
    fs.mkdirSync(path.join(store.root, 'target-a'), { recursive: true });
    fs.mkdirSync(path.join(store.root, 'target-b'), { recursive: true });
    boundTask(store, 'ISSUE-A', 'AC-1', 'target-a', { unit_test: 'CMD-A' });
    boundTask(store, 'ISSUE-A', 'AC-2', 'target-a', { unit_test: 'CMD-A' });
    boundTask(store, 'ISSUE-B', 'AC-1', 'target-b'); // legacy, bound to the CURRENT target

    const calls: { cmd: string; cwd: string }[] = [];
    const runner: RegressReportRunner = (cmd, cwd) => {
      calls.push({ cmd, cwd });
      return fakeReport([
        { name: 'ISSUE-A/AC-1 holds', passed: true },
        { name: 'ISSUE-A/AC-2 holds', passed: true },
        { name: 'ISSUE-B/AC-1 holds', passed: true },
      ]);
    };
    const { results, skipped } = runRegressionTasks(store, cfg('target-b', { unit_tests: 'CMD-B' }), { report: runner });

    expect(skipped).toEqual([]);
    expect(calls).toHaveLength(2); // 3 tasks, 2 targets → 2 runs
    const byCwd = new Map(calls.map((c) => [path.basename(c.cwd), c.cmd]));
    expect(byCwd.get('target-a')).toBe('CMD-A'); // captured command for A
    expect(byCwd.get('target-b')).toBe('CMD-B'); // config fallback for the legacy task
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.result === 'pass')).toBe(true);
  });
});

describe('executor skips with a reason naming the missing precondition (AC-REGMT-003)', () => {
  it('ISSUE-0005/AC-REGMT-003 a bound repo missing from disk → skipped naming the absent repo; no RegressionRun', () => {
    const store = freshStore();
    boundTask(store, 'ISSUE-A', 'AC-1', 'ghost-target', { unit_test: 'CMD-A' });

    const { results, skipped } = runRegressionTasks(store, cfg('target-b', { unit_tests: 'CMD-B' }), {
      report: () => { throw new Error('nothing is runnable — the grader must not run'); },
    });

    expect(results).toEqual([]);
    expect(store.db.regressionRuns).toEqual([]); // nothing fabricated
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toMatch(/exist|missing|absent|not found|不在/i);
    expect(skipped[0]!.reason).toContain('ghost-target'); // names WHICH repo is gone
  });

  it('ISSUE-0005/AC-REGMT-003 a command-less legacy task mismatching config.target → skipped naming the unknown command; no RegressionRun', () => {
    const store = freshStore();
    fs.mkdirSync(path.join(store.root, 'target-a'), { recursive: true }); // repo IS on disk
    boundTask(store, 'ISSUE-B', 'AC-1', 'target-a'); // legacy: no captured commands

    const { results, skipped } = runRegressionTasks(store, cfg('target-b', { unit_tests: 'CMD-B' }), {
      report: () => { throw new Error('nothing is runnable — the grader must not run'); },
    });

    expect(results).toEqual([]);
    expect(store.db.regressionRuns).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toMatch(/command|コマンド/i);
  });
});

describe('legacy fallback is unchanged (AC-REGMT-004)', () => {
  it('ISSUE-0005/AC-REGMT-004 a legacy task bound to the CURRENT target runs via config.target.graders and records a RegressionRun', () => {
    const store = freshStore();
    fs.mkdirSync(path.join(store.root, 'self'), { recursive: true });
    boundTask(store, 'ISSUE-A', 'AC-1', 'self');

    const calls: { cmd: string; cwd: string }[] = [];
    const { results, skipped } = runRegressionTasks(store, cfg('self', { unit_tests: 'CFG-CMD' }), {
      report: (cmd, cwd) => {
        calls.push({ cmd, cwd });
        return fakeReport([{ name: 'ISSUE-A/AC-1 holds', passed: true }]);
      },
    });

    expect(skipped).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('CFG-CMD'); // the config fallback, exactly as before
    expect(path.resolve(calls[0]!.cwd)).toBe(path.resolve(store.root, 'self'));
    expect(results).toHaveLength(1);
    expect(results[0]!.result).toBe('pass');
    expect(store.db.regressionRuns).toHaveLength(1); // recorded, no behavioural regression
  });
});
