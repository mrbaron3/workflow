/**
 * ISSUE-0006 — Enrich command-less legacy tasks with grader commands at curate
 * (spec docs/specs/legacy-task-grader-command-backfill, AC-REGBF-001..003).
 *
 * FEAT-001 (ISSUE-0005) captures grader commands into NEW tasks at curation time, but
 * tasks curated before it exist with graderCommands: null and can only run via the
 * config fallback. Curate therefore additionally ENRICHES: a command-less task bound to
 * the CURRENT config.target.repo gains the same capture mapping (verification method →
 * configured command). Enrichment never duplicates a task, never touches recorded
 * fields, never overwrites a captured command (curation-time record is truth, ADR-0001),
 * and never reaches across targets (capture records what this config actually grades —
 * it does not guess).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/store.js';
import { EvalTask } from '../src/domain/schema.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import { curateEvalTasks } from '../src/pipeline/curator.js';

const dirs: string[] = [];
function freshStore(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-regbf-unit-'));
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

/** A registry task exactly as pre-FEAT-001 curates left it (or with captured commands). */
function seedTask(
  store: Store,
  id: string,
  target: string | null,
  opts: { commands?: Record<string, string>; method?: 'unit_test' | 'typecheck' } = {},
): EvalTask {
  return store.addEvalTask(
    EvalTask.parse({
      id, sourceIssueId: 'ISSUE-A', featureArea: 'backend', userGoal: '[regression] g',
      steps: ['Verify: x'], expected: ['x'], graders: [opts.method ?? 'unit_test'], severity: 'blocker',
      target, ...(opts.commands ? { graderCommands: opts.commands } : {}),
      createdAt: '2026-07-07T00:00:00.000Z',
    }),
  );
}

describe('curate backfills command-less legacy tasks bound to the current target (AC-REGBF-001)', () => {
  it('ISSUE-0006/AC-REGBF-001 a command-less task bound to the current target gains the FEAT-001 capture — no duplicate, recorded fields untouched', () => {
    const store = freshStore();
    seedTask(store, 'EVAL-TASK-ISSUE-A-AC-1', 'self');

    curateEvalTasks(store, cfg('self', { unit_tests: 'CMD-NEW' }));

    expect(store.db.evalTasks).toHaveLength(1); // enriched in place, never duplicated
    const t = store.db.evalTasks[0]!;
    expect(t.graderCommands).toEqual({ unit_test: 'CMD-NEW' });
    // identity and recorded history untouched
    expect(t.id).toBe('EVAL-TASK-ISSUE-A-AC-1');
    expect(t.userGoal).toBe('[regression] g');
    expect(t.steps).toEqual(['Verify: x']);
    expect(t.expected).toEqual(['x']);
    expect(t.severity).toBe('blocker');
    expect(t.target).toBe('self');
    expect(t.createdAt).toBe('2026-07-07T00:00:00.000Z');
  });

  it('ISSUE-0006/AC-REGBF-001 re-running curate changes nothing (enrichment is idempotent)', () => {
    const store = freshStore();
    seedTask(store, 'EVAL-TASK-ISSUE-A-AC-1', 'self');

    const first = curateEvalTasks(store, cfg('self', { unit_tests: 'CMD-NEW' }));
    const second = curateEvalTasks(store, cfg('self', { unit_tests: 'CMD-NEW' }));

    expect(first.enriched.map((t) => t.id)).toEqual(['EVAL-TASK-ISSUE-A-AC-1']);
    expect(second.enriched).toEqual([]); // already captured → nothing to do
    expect(store.db.evalTasks).toHaveLength(1);
    expect(store.db.evalTasks[0]!.graderCommands).toEqual({ unit_test: 'CMD-NEW' });
  });

  it('ISSUE-0006/AC-REGBF-001 the capture follows the task grader method, exactly as FEAT-001 (typecheck task → typecheck command)', () => {
    const store = freshStore();
    seedTask(store, 'EVAL-TASK-ISSUE-A-AC-1', 'self', { method: 'typecheck' });

    curateEvalTasks(store, cfg('self', { typecheck: 'tsc --noEmit', unit_tests: 'CMD-NEW' }));

    expect(store.db.evalTasks[0]!.graderCommands).toEqual({ typecheck: 'tsc --noEmit' });
  });

  it('ISSUE-0006/AC-REGBF-001 a method with no configured command captures nothing (never fabricated — FEAT-001 red line)', () => {
    const store = freshStore();
    seedTask(store, 'EVAL-TASK-ISSUE-A-AC-1', 'self');

    const { enriched } = curateEvalTasks(store, cfg('self', { typecheck: 'tsc --noEmit' })); // no unit_tests command

    expect(enriched).toEqual([]);
    expect(store.db.evalTasks[0]!.graderCommands).toBeNull(); // still legacy, nothing invented
  });

  it('ISSUE-0006/AC-REGBF-001 the enrichment survives a save/load round-trip (the task keeps its execution means)', () => {
    const store = freshStore();
    seedTask(store, 'EVAL-TASK-ISSUE-A-AC-1', 'self');
    curateEvalTasks(store, cfg('self', { unit_tests: 'CMD-NEW' }));
    store.save();
    const reloaded = new Store(store.root);
    expect(reloaded.db.evalTasks[0]!.graderCommands).toEqual({ unit_test: 'CMD-NEW' });
  });
});

describe('captured commands are never overwritten (AC-REGBF-002)', () => {
  it('ISSUE-0006/AC-REGBF-002 a task with captured commands keeps them even when config holds a DIFFERENT command', () => {
    const store = freshStore();
    seedTask(store, 'EVAL-TASK-ISSUE-A-AC-1', 'self', { commands: { unit_test: 'CMD-OLD' } });

    const { enriched } = curateEvalTasks(store, cfg('self', { unit_tests: 'CMD-DIFFERENT' }));

    expect(enriched).toEqual([]);
    // curation-time record is truth (ADR-0001) — config drift must not rewrite history
    expect(store.db.evalTasks[0]!.graderCommands).toEqual({ unit_test: 'CMD-OLD' });
  });
});

describe('other-target and unbound tasks are out of enrichment scope (AC-REGBF-003)', () => {
  it('ISSUE-0006/AC-REGBF-003 a command-less task bound to ANOTHER target stays command-less', () => {
    const store = freshStore();
    seedTask(store, 'EVAL-TASK-ISSUE-A-AC-1', 'other-target');

    const { enriched } = curateEvalTasks(store, cfg('self', { unit_tests: 'CMD-NEW' }));

    expect(enriched).toEqual([]);
    expect(store.db.evalTasks[0]!.graderCommands).toBeNull(); // not this config's to claim
  });

  it('ISSUE-0006/AC-REGBF-003 an unbound (target: null) legacy task stays command-less', () => {
    const store = freshStore();
    seedTask(store, 'EVAL-TASK-ISSUE-A-AC-2', null);

    const { enriched } = curateEvalTasks(store, cfg('self', { unit_tests: 'CMD-NEW' }));

    expect(enriched).toEqual([]);
    expect(store.db.evalTasks[0]!.graderCommands).toBeNull(); // skipped, never guessed
  });
});
