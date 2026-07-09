/**
 * Dependency-ordered multi-issue drive (ISSUE-0018, AC-DAG-001..004).
 *
 * The execution guard learns the spec's issue DAG: an ai-managed issue whose
 * dependsOnIssues are not all `released` is held back from the pollable queue —
 * never silently: `blockedByDependencies` reports machine-readably which issue
 * waits on which dependency in which status, and the live turn log names them.
 * The deterministic coordinator (`runAll`) drives a chain in dependency order,
 * re-evaluating eligibility as predecessors release. Spawn hygiene (unknown
 * keys / cycles rejected loudly, nothing partially spawned) is pinned as the
 * backward-compat half.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, nowISO } from '../src/store/store.js';
import { Issue } from '../src/domain/schema.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import { pollable, blockedByDependencies } from '../src/pipeline/execution/guard.js';
import { runAll } from '../src/pipeline/coordinator.js';
import { runLoopLive } from '../src/pipeline/execution/live.js';
import { planRoadmap, spawnSpecs, spawnIssues } from '../src/planning/planning-tree.js';
import type { AgentRunner } from '../src/agents/runner.js';
import type { BuildArtifact } from '../src/domain/artifact.js';

function freshStore(): Store {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-dep-')));
}

const CLAUDE: HarnessConfig = { ...DEFAULT_CONFIG, generator: 'claude' };
const MOCK: HarnessConfig = { ...DEFAULT_CONFIG, generator: 'mock', samples: 1, maxRepairs: 1 };

const contract = {
  productGoal: 'g',
  userStory: 'u',
  scope: { include: [], exclude: [] },
  acceptanceCriteria: [
    { id: 'AC-1', severity: 'blocker' as const, behavior: 'b', verification: { method: 'unit_test' as const, expected: ['x'] } },
  ],
  redLines: [],
};

function mkIssue(store: Store, id: string, o: { status?: string; agent?: string | null; deps?: string[] } = {}): void {
  store.addIssue(
    Issue.parse({
      id,
      type: 'harness',
      title: `t-${id}`,
      area: 'harness',
      status: o.status ?? 'contract-drafted',
      assignedAgent: o.agent === undefined ? 'claude' : o.agent,
      dependsOnIssues: o.deps ?? [],
      contract,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    }),
  );
}

/** Always-approving runner that records dispatch order and any dep-not-released violation. */
function greenRunner(store: Store, dispatched: string[], violations: string[]): AgentRunner {
  return {
    agent: 'mock',
    generate: async (input) => {
      dispatched.push(input.issue.id);
      for (const dep of input.issue.dependsOnIssues) {
        if (store.getIssue(dep)?.status !== 'released') violations.push(`${input.issue.id} dispatched while ${dep} unreleased`);
      }
      const artifact: BuildArtifact = {
        branch: `agent/${input.issue.id.toLowerCase()}`,
        summary: 's',
        filesChanged: ['src/x.ts', 'test/x.test.ts'],
        satisfied: Object.fromEntries(input.contract.acceptanceCriteria.map((a) => [a.id, true])),
        buildPasses: true,
        typecheckPasses: true,
        unitTestsPass: true,
        apiTestsPass: true,
        hasTests: true,
        secretsLeaked: false,
        scopeViolations: [],
        quality: { codeQuality: 0.9, testQuality: 0.9, ux: 0.9, accessibility: 0.9 },
        notes: [],
      };
      return artifact;
    },
  };
}

describe('execution guard respects issue dependencies (AC-DAG-001/002)', () => {
  it('ISSUE-0018/AC-DAG-001 an ai-managed issue with an unreleased dependency is not pollable; deps-empty issues keep today\'s behavior', () => {
    const store = freshStore();
    // one unreleased dependency per status class the AC names
    mkIssue(store, 'ISSUE-A1', { status: 'planned', agent: null });
    mkIssue(store, 'ISSUE-A2', { status: 'generation-in-progress', agent: null });
    mkIssue(store, 'ISSUE-A3', { status: 'needs-human-review', agent: null });
    mkIssue(store, 'ISSUE-A4', { status: 'closed', agent: null });
    mkIssue(store, 'ISSUE-B1', { deps: ['ISSUE-A1'] });
    mkIssue(store, 'ISSUE-B2', { deps: ['ISSUE-A2'] });
    mkIssue(store, 'ISSUE-B3', { deps: ['ISSUE-A3'] });
    mkIssue(store, 'ISSUE-B4', { deps: ['ISSUE-A4'] });
    // backward compat: no deps → pollable exactly as before
    mkIssue(store, 'ISSUE-L', {});
    // a released dependency does not block
    mkIssue(store, 'ISSUE-R', { status: 'released', agent: null });
    mkIssue(store, 'ISSUE-D', { deps: ['ISSUE-R'] });

    const ids = pollable(store, CLAUDE).map((i) => i.id);
    expect(ids).toEqual(['ISSUE-D', 'ISSUE-L']); // blocked B1..B4 absent, deps-empty & deps-released present
  });

  it('ISSUE-0018/AC-DAG-001 blockedByDependencies reports which issue waits on which dependency in which status (machine-readable, never silent)', () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-A', { status: 'planned', agent: null });
    mkIssue(store, 'ISSUE-B', { deps: ['ISSUE-A'] });
    mkIssue(store, 'ISSUE-F', { status: 'closed', agent: null });
    mkIssue(store, 'ISSUE-G', { deps: ['ISSUE-F'] });
    mkIssue(store, 'ISSUE-M', { deps: ['ISSUE-NOPE'] }); // dep missing from the store — loud, not silent
    mkIssue(store, 'ISSUE-L', {}); // unblocked: not in the report

    const blocked = blockedByDependencies(store, CLAUDE);
    expect(blocked).toEqual([
      { issueId: 'ISSUE-B', waitingOn: [{ dependencyId: 'ISSUE-A', status: 'planned' }] },
      { issueId: 'ISSUE-G', waitingOn: [{ dependencyId: 'ISSUE-F', status: 'closed' }] },
      { issueId: 'ISSUE-M', waitingOn: [{ dependencyId: 'ISSUE-NOPE', status: 'missing' }] },
    ]);
    expect(pollable(store, CLAUDE).map((i) => i.id)).toEqual(['ISSUE-L']);
  });

  it('ISSUE-0018/AC-DAG-001 the live turn log names the blocked issue, its dependency and the dependency\'s status', async () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-A', { status: 'planned', agent: null });
    mkIssue(store, 'ISSUE-B', { deps: ['ISSUE-A'] });

    const lines: string[] = [];
    await runLoopLive(store, CLAUDE, store.root, {}, (m) => lines.push(m));
    const log = lines.join('\n');
    expect(log).toContain('ISSUE-B');
    expect(log).toContain('ISSUE-A');
    expect(log).toContain('planned');
  });

  it('ISSUE-0018/AC-DAG-001 with two dependencies and only one released, the issue stays blocked and ONLY the unreleased dependency is reported', () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-R', { status: 'released', agent: null });
    mkIssue(store, 'ISSUE-A', { status: 'planned', agent: null });
    mkIssue(store, 'ISSUE-B', { deps: ['ISSUE-R', 'ISSUE-A'] }); // one of two released ≠ satisfied

    expect(pollable(store, CLAUDE).map((i) => i.id)).not.toContain('ISSUE-B');
    expect(blockedByDependencies(store, CLAUDE)).toEqual([
      { issueId: 'ISSUE-B', waitingOn: [{ dependencyId: 'ISSUE-A', status: 'planned' }] },
    ]); // the released ISSUE-R must not appear as a wait
  });

  it('ISSUE-0018/AC-DAG-002 unblocking requires the LAST dependency: only releasing the second of two makes the issue pollable', () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-R', { status: 'released', agent: null });
    mkIssue(store, 'ISSUE-A', { status: 'planned', agent: null });
    mkIssue(store, 'ISSUE-B', { deps: ['ISSUE-R', 'ISSUE-A'] });
    expect(pollable(store, CLAUDE).map((i) => i.id)).not.toContain('ISSUE-B'); // first released alone is not enough

    store.setStatus('ISSUE-A', 'needs-human-review');
    store.setStatus('ISSUE-A', 'released');

    expect(pollable(store, CLAUDE).map((i) => i.id)).toContain('ISSUE-B'); // ALL deps released → next poll picks it up
    expect(blockedByDependencies(store, CLAUDE)).toEqual([]);
  });

  it('ISSUE-0018/AC-DAG-002 a dependency transitioning to released unblocks the dependent on the next poll — no re-assign, no re-registration', () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-A', { status: 'planned', agent: null });
    mkIssue(store, 'ISSUE-B', { deps: ['ISSUE-A'] });
    expect(pollable(store, CLAUDE).map((i) => i.id)).not.toContain('ISSUE-B');

    store.setStatus('ISSUE-A', 'needs-human-review');
    store.setStatus('ISSUE-A', 'released');

    expect(pollable(store, CLAUDE).map((i) => i.id)).toContain('ISSUE-B'); // untouched otherwise
    expect(blockedByDependencies(store, CLAUDE)).toEqual([]); // and no longer reported blocked
  });
});

describe('deterministic chain drive (AC-DAG-003)', () => {
  it('ISSUE-0018/AC-DAG-003 runAll drives A←B←C in dependency order in ONE call, re-evaluating eligibility as the chain progresses', async () => {
    const store = freshStore();
    // Inserted in REVERSE order: a deps-blind snapshot loop would dispatch C first.
    mkIssue(store, 'ISSUE-C', { agent: 'mock', deps: ['ISSUE-B'] });
    mkIssue(store, 'ISSUE-B', { agent: 'mock', deps: ['ISSUE-A'] });
    mkIssue(store, 'ISSUE-A', { agent: 'mock' });

    const dispatched: string[] = [];
    const violations: string[] = [];
    const results = await runAll(store, MOCK, () => {}, greenRunner(store, dispatched, violations));

    expect(dispatched).toEqual(['ISSUE-A', 'ISSUE-B', 'ISSUE-C']); // dependency order, not insertion order
    expect(violations).toEqual([]); // no issue reached the runner before its deps were released
    expect(results.map((r) => r.issueId)).toEqual(['ISSUE-A', 'ISSUE-B', 'ISSUE-C']);
    for (const id of ['ISSUE-A', 'ISSUE-B', 'ISSUE-C']) {
      expect(store.getIssue(id)!.status).toBe('released'); // the whole chain landed in one call
    }
  });

  it('ISSUE-0018/AC-DAG-003 an issue whose dependency never releases is left untouched and reported, not dispatched', async () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-W', { agent: 'mock', deps: ['ISSUE-GONE'] }); // dep does not exist → can never release
    mkIssue(store, 'ISSUE-A', { agent: 'mock' });

    const dispatched: string[] = [];
    const lines: string[] = [];
    await runAll(store, MOCK, (m) => lines.push(m), greenRunner(store, dispatched, []));

    expect(dispatched).toEqual(['ISSUE-A']);
    expect(store.getIssue('ISSUE-W')!.status).toBe('contract-drafted'); // block is not a state transition
    expect(lines.join('\n')).toContain('ISSUE-W'); // and it is reported, not silently dropped
    expect(lines.join('\n')).toContain('ISSUE-GONE');
  });
});

describe('spawn hygiene (AC-DAG-004, backward compat)', () => {
  /** Plan a 1-feature tree, sign its spec, and drop the given issues.yaml beside it. */
  function author(manifest: string): { store: Store; specPath: string } {
    const store = freshStore();
    planRoadmap(store, {
      vision: 'v',
      principles: [],
      epics: [{ id: 'EPIC-01', title: 'e', theme: 't', outcome: 'o', features: [{ id: 'FEAT-001', title: 'f', outcome: 'o' }] }],
    });
    spawnSpecs(store);
    const f = store.getFeature('FEAT-001')!;
    const specAbs = path.resolve(store.root, f.specPath!);
    fs.writeFileSync(
      path.join(specAbs, 'spec.md'),
      '# Spec\n\n## 受け入れ基準\n- **[AC-X-001]** behavior one\n- **[AC-X-002]** behavior two\n',
      'utf8',
    );
    const st = store.getSpecState(f.specPath!)!;
    st.approved = {
      signedCommitSha: 'deadbeef',
      specBlobGitSha: 'a',
      acceptanceBlobGitSha: 'b',
      acFingerprints: { 'AC-X-001': 'fp1', 'AC-X-002': 'fp2' },
      systemRefs: [],
      approvedAcIds: ['AC-X-001', 'AC-X-002'],
    };
    st.signedAt = nowISO();
    fs.writeFileSync(path.join(specAbs, 'issues.yaml'), manifest, 'utf8');
    return { store, specPath: f.specPath! };
  }

  it('ISSUE-0018/AC-DAG-004 a dependsOnIssues key in neither the manifest nor the store is rejected loudly, spawning nothing', () => {
    const { store, specPath } = author(`issues:
  - key: K-1
    title: first
    area: backend
    coversAcIds: [AC-X-001]
  - key: K-2
    title: second
    area: backend
    coversAcIds: [AC-X-002]
    dependsOnIssues: [K-TYPO]
`);
    expect(() => spawnIssues(store, specPath)).toThrow(/K-TYPO/);
    expect(store.db.issues).toHaveLength(0); // nothing partially spawned
  });

  it('ISSUE-0018/AC-DAG-004 a manifest-internal dependency cycle is rejected loudly, spawning nothing', () => {
    const { store, specPath } = author(`issues:
  - key: K-1
    title: first
    area: backend
    coversAcIds: [AC-X-001]
    dependsOnIssues: [K-2]
  - key: K-2
    title: second
    area: backend
    coversAcIds: [AC-X-002]
    dependsOnIssues: [K-1]
`);
    expect(() => spawnIssues(store, specPath)).toThrow(/cycle|circular|循環/i);
    expect(store.db.issues).toHaveLength(0);
  });

  it('ISSUE-0018/AC-DAG-004 known-key remapping and direct references to existing store issue ids keep working', () => {
    const { store, specPath } = author(`issues:
  - key: K-1
    title: first
    area: backend
    coversAcIds: [AC-X-001]
  - key: K-2
    title: second
    area: backend
    coversAcIds: [AC-X-002]
    dependsOnIssues: [K-1, ISSUE-9000]
`);
    // a predecessor that already exists in the store (cross-spec dependency)
    store.addIssue(
      Issue.parse({
        id: 'ISSUE-9000',
        type: 'story',
        title: 'pre-existing',
        area: 'backend',
        createdAt: nowISO(),
        updatedAt: nowISO(),
      }),
    );

    spawnIssues(store, specPath);
    const first = store.db.issues.find((i) => i.title === 'first')!;
    const second = store.db.issues.find((i) => i.title === 'second')!;
    expect(second.dependsOnIssues).toEqual([first.id, 'ISSUE-9000']); // key remapped; store id passed through
  });
});
