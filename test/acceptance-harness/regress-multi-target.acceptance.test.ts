/**
 * Env-gated acceptance grader for ISSUE-0005 "Bind grader commands at curate and execute
 * regression tasks per target" — the FIRST issue to arrive through the full upstream chain
 * (roadmap → spec → sign → spawn-issues → contract-draft → assign), spec
 * docs/specs/regression-multi-target-execution (AC-REGMT-001..004).
 *
 * RED at baseline BY DESIGN, collected only under ACCEPT_HARNESS=1 (ADR-0007 I3): the
 * drive's real Claude session must make it pass but cannot edit it
 * (config.target.protectedPaths). After the fix is human-approved and released, drop the
 * skipIf so it becomes a permanent regression guard (per the promoted siblings here).
 *
 * The seam this file pins (harness-owned WHAT confirmation, like roman's toRoman/fromRoman):
 *   - EvalTask carries `graderCommands` — a per-VERIFICATION-METHOD command record captured
 *     at curate time (key 'unit_test', value the executable command), null/absent = legacy.
 *   - runRegressionTasks executes per bound target: captured-command tasks run even when
 *     task.target !== config.target.repo, provided the target repo exists on disk.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, nowISO } from '../../src/store/store.js';
import { Issue, EvalRun, EvalTask } from '../../src/domain/schema.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../../src/config.js';
import { curateEvalTasks } from '../../src/pipeline/curator.js';
import { runRegressionTasks } from '../../src/pipeline/regression.js';
import type { VitestReport } from '../../src/pipeline/execution/grade.js';

const dirs: string[] = [];
function freshStore(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-regmt-'));
  dirs.push(root);
  return new Store(root);
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function cfg(repo: string, unitTests?: string): HarnessConfig {
  return {
    ...DEFAULT_CONFIG,
    generator: 'claude',
    target: { repo, baseRef: 'HEAD', ...(unitTests ? { graders: { unit_tests: unitTests } } : {}) },
  };
}

/** An issue with one blocker unit_test AC plus one graded run, so curate promotes it. */
function seedIssueWithRun(store: Store, id: string): void {
  store.addIssue(
    Issue.parse({
      id, type: 'story', title: 't', area: 'backend', status: 'contract-drafted',
      assignedAgent: 'claude', createdAt: nowISO(), updatedAt: nowISO(),
      contract: {
        productGoal: 'g', userStory: 'u', scope: { include: [], exclude: [] },
        acceptanceCriteria: [
          { id: 'AC-1', severity: 'blocker', behavior: 'b', verification: { method: 'unit_test', expected: ['x'] } },
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
): void {
  store.addEvalTask(
    EvalTask.parse({
      id: `EVAL-TASK-${issueId}-${acId}`, sourceIssueId: issueId, featureArea: 'backend',
      userGoal: 'g', expected: ['x'], graders: ['unit_test'], severity: 'blocker',
      target, ...(commands ? { graderCommands: commands } : {}), createdAt: nowISO(),
    }),
  );
}

function fakeReport(assertions: { name: string; passed: boolean }[]): VitestReport {
  const failed = assertions.filter((a) => !a.passed);
  return { success: failed.length === 0, total: assertions.length, passed: assertions.length - failed.length, failedNames: failed.map((a) => a.name), assertions };
}

describe.skipIf(!process.env.ACCEPT_HARNESS)('regression multi-target execution (ISSUE-0005)', () => {
  it('ISSUE-0005/AC-REGMT-001 curate captures the grader command for the task\'s method — and never invents one', () => {
    const store = freshStore();
    seedIssueWithRun(store, 'ISSUE-A');
    const { created } = curateEvalTasks(store, cfg('target-a', 'CMD-A'));
    const task = created.find((t) => t.id === 'EVAL-TASK-ISSUE-A-AC-1')!;
    expect(task.target).toBe('target-a');
    expect((task as { graderCommands?: Record<string, string> | null }).graderCommands?.['unit_test']).toBe('CMD-A');

    // No unit_tests command configured → nothing captured for that method (nothing fabricated).
    const store2 = freshStore();
    seedIssueWithRun(store2, 'ISSUE-B');
    const { created: c2 } = curateEvalTasks(store2, cfg('target-a'));
    const t2 = c2.find((t) => t.id === 'EVAL-TASK-ISSUE-B-AC-1')!;
    expect((t2 as { graderCommands?: Record<string, string> | null }).graderCommands?.['unit_test']).toBeUndefined();
  });

  it('ISSUE-0005/AC-REGMT-002 a command-carrying task bound to another ON-DISK target executes there — one shared run per target', () => {
    const store = freshStore();
    fs.mkdirSync(path.join(store.root, 'target-a'), { recursive: true });
    fs.mkdirSync(path.join(store.root, 'target-b'), { recursive: true });
    boundTask(store, 'ISSUE-A', 'AC-1', 'target-a', { unit_test: 'CMD-A' });
    boundTask(store, 'ISSUE-A', 'AC-2', 'target-a', { unit_test: 'CMD-A' });

    const calls: { cmd: string; cwd: string }[] = [];
    const { results, skipped } = runRegressionTasks(store, cfg('target-b', 'CMD-B'), {
      report: (cmd, cwd) => {
        calls.push({ cmd, cwd });
        return fakeReport([
          { name: 'ISSUE-A/AC-1 holds', passed: true },
          { name: 'ISSUE-A/AC-2 holds', passed: false },
        ]);
      },
    });

    expect(skipped).toEqual([]); // config points at B, yet the A-bound tasks are NOT skipped
    expect(calls).toHaveLength(1); // two tasks, same target → ONE shared grader run
    expect(calls[0]!.cmd).toBe('CMD-A'); // the CAPTURED command, not config's
    expect(path.resolve(calls[0]!.cwd)).toBe(path.resolve(store.root, 'target-a'));
    expect(results.find((r) => r.taskId === 'EVAL-TASK-ISSUE-A-AC-1')!.result).toBe('pass');
    expect(results.find((r) => r.taskId === 'EVAL-TASK-ISSUE-A-AC-2')!.result).toBe('fail');
  });

  it('ISSUE-0005/AC-REGMT-003 a missing repo or an unknown command is skipped with a reason naming that precondition — no run fabricated', () => {
    const store = freshStore();
    fs.mkdirSync(path.join(store.root, 'target-a'), { recursive: true });
    // (a) commands captured, but the bound repo is gone from disk.
    boundTask(store, 'ISSUE-A', 'AC-1', 'ghost-target', { unit_test: 'CMD-A' });
    // (b) legacy (no commands) bound to a target that is NOT the current config target.
    boundTask(store, 'ISSUE-B', 'AC-1', 'target-a');

    const { results, skipped } = runRegressionTasks(store, cfg('target-b', 'CMD-B'), {
      report: () => { throw new Error('nothing is runnable — the runner must not be called'); },
    });

    expect(results).toEqual([]);
    expect(store.db.regressionRuns ?? []).toEqual([]);
    const ghost = skipped.find((s) => s.taskId === 'EVAL-TASK-ISSUE-A-AC-1')!;
    expect(ghost.reason).toMatch(/exist|missing|absent|not found|不在/i); // names the missing repo
    const legacy = skipped.find((s) => s.taskId === 'EVAL-TASK-ISSUE-B-AC-1')!;
    expect(legacy.reason).toMatch(/command|コマンド/i); // names the unknown command
  });

  it('ISSUE-0005/AC-REGMT-004 a legacy task bound to the CURRENT target still runs via config graders (no regression)', () => {
    const store = freshStore();
    fs.mkdirSync(path.join(store.root, 'self'), { recursive: true });
    boundTask(store, 'ISSUE-A', 'AC-1', 'self');

    const calls: { cmd: string; cwd: string }[] = [];
    const { results, skipped } = runRegressionTasks(store, cfg('self', 'CFG-CMD'), {
      report: (cmd, cwd) => {
        calls.push({ cmd, cwd });
        return fakeReport([{ name: 'ISSUE-A/AC-1 holds', passed: true }]);
      },
    });

    expect(skipped).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('CFG-CMD'); // the config fallback, exactly as before
    expect(results[0]!.result).toBe('pass');
  });
});
