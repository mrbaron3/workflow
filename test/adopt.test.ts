/**
 * Adoption (ADR-0007 I1): the transition that closes the ③ loop's structural break.
 * An Analyst proposal is planned/contract-less — deliberately invisible to the execution
 * guard. adoptIssue is the human WHAT-confirmation: contract attached (validated), status
 * walked through the state machine, assignedAgent set — after which the SAME pollable
 * predicate that drives feature work picks the improvement issue up. No special pipeline.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, nowISO } from '../src/store/store.js';
import { Issue } from '../src/domain/schema.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import { adoptIssue } from '../src/pipeline/adopt.js';
import { createSuggestionIssues } from '../src/pipeline/analyst.js';
import { pollable } from '../src/pipeline/execution/guard.js';

const CONFIG: HarnessConfig = { ...DEFAULT_CONFIG, generator: 'claude' };

const dirs: string[] = [];
function freshStore(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-adopt-'));
  dirs.push(root);
  return new Store(root);
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const contract = {
  productGoal: 'scope_check honors scope.exclude',
  userStory: 'as the operator I want exclude enforced',
  scope: { include: ['src/**', 'test/**'], exclude: ['test/acceptance-harness/**'] },
  acceptanceCriteria: [
    { id: 'AC-1', severity: 'blocker', behavior: 'excluded file is a violation', verification: { method: 'unit_test', expected: ['x'] } },
  ],
  redLines: [],
};

/** A proposal exactly as the Analyst creates it: planned, no contract, unassigned. */
function proposal(store: Store): Issue {
  return createSuggestionIssues(store, [
    { type: 'harness', area: 'harness', title: 'Fix scope_check exclude', rationale: 'r' },
  ])[0]!;
}

describe('adoptIssue — a proposal becomes drivable, through the same guard as feature work', () => {
  it('an adopted Analyst proposal enters the pollable queue', () => {
    const store = freshStore();
    const p = proposal(store);
    expect(pollable(store, CONFIG).map((i) => i.id)).not.toContain(p.id); // proposal: invisible

    const adopted = adoptIssue(store, CONFIG, p.id, { contract, dependsOnSystem: ['ARCH-execution-006'] });

    expect(adopted.status).toBe('contract-drafted');
    expect(adopted.assignedAgent).toBe('claude');
    expect(adopted.contract?.acceptanceCriteria[0]?.id).toBe('AC-1');
    expect(adopted.dependsOnSystem).toEqual(['ARCH-execution-006']);
    expect(pollable(store, CONFIG).map((i) => i.id)).toContain(p.id); // adopted: ai-managed
  });

  it('rejects an invalid contract loudly (an invalid WHAT never reaches the loop)', () => {
    const store = freshStore();
    const p = proposal(store);
    expect(() => adoptIssue(store, CONFIG, p.id, { contract: { productGoal: 'g' } })).toThrow();
    expect(store.getIssue(p.id)!.status).toBe('planned'); // untouched on failure
  });

  it('adopts only proposals: refuses issues already past planned/ready-for-contract', () => {
    const store = freshStore();
    const issue = store.addIssue(
      Issue.parse({
        id: 'ISSUE-9999', type: 'story', title: 't', area: 'backend', status: 'contract-drafted',
        assignedAgent: 'claude', contract, epicId: null, sprint: null, createdAt: nowISO(), updatedAt: nowISO(),
      }),
    );
    expect(() => adoptIssue(store, CONFIG, issue.id, { contract })).toThrow(/adopt only confirms/);
    expect(() => adoptIssue(store, CONFIG, 'ISSUE-0000', { contract })).toThrow(/no such issue/);
  });
});
