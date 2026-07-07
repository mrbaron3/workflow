/**
 * Env-gated acceptance grader for ISSUE-0006 "Enrich command-less legacy tasks with grader
 * commands at curate" — second issue through the upstream chain, spec
 * docs/specs/legacy-task-grader-command-backfill (AC-REGBF-001..003).
 *
 * RED at baseline BY DESIGN, collected only under ACCEPT_HARNESS=1 (ADR-0007 I3): the
 * drive's real Claude session must make it pass but cannot edit it
 * (config.target.protectedPaths). After the fix is human-approved and released, drop the
 * skipIf so it becomes a permanent regression guard (per the promoted siblings here).
 *
 * The seam this file pins: curateEvalTasks(store, config) additionally ENRICHES — a task
 * bound to config.target.repo whose graderCommands is null gains the FEAT-001 capture
 * (key = verification method); it never duplicates a task, never touches other fields,
 * never overwrites captured commands, and never reaches across targets.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, nowISO } from '../../src/store/store.js';
import { EvalTask } from '../../src/domain/schema.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../../src/config.js';
import { curateEvalTasks } from '../../src/pipeline/curator.js';

const dirs: string[] = [];
function freshStore(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-regbf-'));
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

/** A registry task exactly as pre-FEAT-001 curates left it (or with captured commands). */
function seedTask(store: Store, id: string, target: string | null, commands?: Record<string, string>): EvalTask {
  return store.addEvalTask(
    EvalTask.parse({
      id, sourceIssueId: 'ISSUE-A', featureArea: 'backend', userGoal: '[regression] g',
      steps: ['Verify: x'], expected: ['x'], graders: ['unit_test'], severity: 'blocker',
      target, ...(commands ? { graderCommands: commands } : {}), createdAt: '2026-07-07T00:00:00.000Z',
    }),
  );
}

const commandsOf = (t: EvalTask): Record<string, string> | null =>
  (t as { graderCommands?: Record<string, string> | null }).graderCommands ?? null;

describe.skipIf(!process.env.ACCEPT_HARNESS)('curate backfills legacy tasks (ISSUE-0006)', () => {
  it('ISSUE-0006/AC-REGBF-001 a command-less task bound to the current target gains the FEAT-001 capture — no duplicate, other fields untouched, idempotent', () => {
    const store = freshStore();
    seedTask(store, 'EVAL-TASK-ISSUE-A-AC-1', 'self');

    curateEvalTasks(store, cfg('self', 'CMD-NEW'));

    expect(store.db.evalTasks).toHaveLength(1); // enriched in place, never duplicated
    const t = store.db.evalTasks[0]!;
    expect(commandsOf(t)).toEqual({ unit_test: 'CMD-NEW' });
    // identity and recorded history untouched
    expect(t.id).toBe('EVAL-TASK-ISSUE-A-AC-1');
    expect(t.userGoal).toBe('[regression] g');
    expect(t.steps).toEqual(['Verify: x']);
    expect(t.expected).toEqual(['x']);
    expect(t.severity).toBe('blocker');
    expect(t.target).toBe('self');
    expect(t.createdAt).toBe('2026-07-07T00:00:00.000Z');

    curateEvalTasks(store, cfg('self', 'CMD-NEW')); // idempotent re-run
    expect(store.db.evalTasks).toHaveLength(1);
    expect(commandsOf(store.db.evalTasks[0]!)).toEqual({ unit_test: 'CMD-NEW' });
  });

  it('ISSUE-0006/AC-REGBF-002 captured commands are never overwritten by a differing config', () => {
    const store = freshStore();
    seedTask(store, 'EVAL-TASK-ISSUE-A-AC-1', 'self', { unit_test: 'CMD-OLD' });

    curateEvalTasks(store, cfg('self', 'CMD-DIFFERENT'));

    expect(commandsOf(store.db.evalTasks[0]!)).toEqual({ unit_test: 'CMD-OLD' }); // curation-time record wins
  });

  it('ISSUE-0006/AC-REGBF-003 tasks bound to another target, or unbound, are not enriched', () => {
    const store = freshStore();
    seedTask(store, 'EVAL-TASK-ISSUE-A-AC-1', 'other-target');
    seedTask(store, 'EVAL-TASK-ISSUE-A-AC-2', null);

    curateEvalTasks(store, cfg('self', 'CMD-NEW'));

    expect(commandsOf(store.db.evalTasks[0]!)).toBeNull(); // another target: not this config's to claim
    expect(commandsOf(store.db.evalTasks[1]!)).toBeNull(); // unbound legacy: skipped, never guessed
  });
});
