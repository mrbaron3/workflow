/**
 * Assignment — the delegation opt-in that closes the UPSTREAM chain's structural break.
 *
 * A spec-spawned issue arrives at contract-drafted with assignedAgent=null: the sign gate
 * confirmed the WHAT, but delegating the HOW to an AI backend is a SEPARATE human decision
 * (DOM-execution-006's default non-processing). adoptIssue cannot express it — it only
 * confirms planned proposals. assignIssue is that missing hand-off: contract already
 * present and validated upstream, status already contract-drafted, the ONLY mutation is
 * assignedAgent = config.generator — after which the same pollable predicate that drives
 * adopted improvements picks the spec-driven issue up.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, nowISO } from '../src/store/store.js';
import { Issue } from '../src/domain/schema.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import { assignIssue } from '../src/pipeline/assign.js';
import { pollable } from '../src/pipeline/execution/guard.js';

const CONFIG: HarnessConfig = { ...DEFAULT_CONFIG, generator: 'claude' };

const dirs: string[] = [];
function freshStore(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-assign-'));
  dirs.push(root);
  return new Store(root);
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const contract = {
  productGoal: 'regress executes tasks bound to any on-disk target',
  userStory: 'as the operator I want sandbox-bound tasks re-verified while target is self',
  scope: { include: ['src/**', 'test/**'], exclude: ['test/acceptance-harness/**'] },
  acceptanceCriteria: [
    { id: 'AC-1', severity: 'blocker', behavior: 'b', verification: { method: 'unit_test', expected: ['x'] } },
  ],
  redLines: [],
};

/** An issue exactly as spawn-issues + contract-draft leave it: drafted, unassigned. */
function specDrafted(store: Store): Issue {
  return store.addIssue(
    Issue.parse({
      id: store.nextId('ISSUE'), type: 'story', title: 'Regression multi-target execution',
      area: 'backend', status: 'contract-drafted', assignedAgent: null, contract,
      specPath: 'docs/specs/regression-multi-target', coversAcIds: ['AC-1'],
      createdAt: nowISO(), updatedAt: nowISO(),
    }),
  );
}

describe('assignIssue — a signed, drafted WHAT is explicitly delegated to the AI backend', () => {
  it('an assigned spec-spawned issue enters the pollable queue (and not before)', () => {
    const store = freshStore();
    const issue = specDrafted(store);
    expect(pollable(store, CONFIG).map((i) => i.id)).not.toContain(issue.id); // drafted: still invisible

    const assigned = assignIssue(store, CONFIG, issue.id);

    expect(assigned.status).toBe('contract-drafted'); // status untouched — only the delegation flips
    expect(assigned.assignedAgent).toBe('claude');
    expect(pollable(store, CONFIG).map((i) => i.id)).toContain(issue.id);
  });

  it('is idempotent: re-assigning an already-delegated issue is a no-op confirmation', () => {
    const store = freshStore();
    const issue = specDrafted(store);
    assignIssue(store, CONFIG, issue.id);
    const again = assignIssue(store, CONFIG, issue.id);
    expect(again.assignedAgent).toBe('claude');
  });

  it('refuses an issue that is not contract-drafted (a proposal goes through adopt)', () => {
    const store = freshStore();
    const proposal = store.addIssue(
      Issue.parse({
        id: store.nextId('ISSUE'), type: 'harness', title: 'p', area: 'harness',
        status: 'planned', createdAt: nowISO(), updatedAt: nowISO(),
      }),
    );
    expect(() => assignIssue(store, CONFIG, proposal.id)).toThrow(/contract-drafted/);
    expect(store.getIssue(proposal.id)!.assignedAgent).toBeNull(); // untouched on failure
  });

  it('refuses a drafted issue with no contract, and an unknown id, loudly', () => {
    const store = freshStore();
    const broken = store.addIssue(
      Issue.parse({
        id: store.nextId('ISSUE'), type: 'story', title: 'b', area: 'backend',
        status: 'contract-drafted', createdAt: nowISO(), updatedAt: nowISO(),
      }),
    );
    expect(() => assignIssue(store, CONFIG, broken.id)).toThrow(/no contract/);
    expect(() => assignIssue(store, CONFIG, 'ISSUE-0000')).toThrow(/no such issue/);
  });
});
