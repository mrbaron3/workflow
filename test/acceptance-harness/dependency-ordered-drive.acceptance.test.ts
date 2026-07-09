/**
 * Env-gated acceptance grader for ISSUE-0018 "Respect issue dependencies in the execution
 * guard and drive chains in order" — spec docs/specs/dependency-ordered-multi-issue-drive
 * (AC-DAG-001..004, FEAT-007 / M2 前半).
 *
 * Red at baseline BY DESIGN, collected only under ACCEPT_HARNESS=1 (ADR-0007 I3). After the
 * build is human-approved and released, the skipIf is dropped and this file stays in
 * protectedPaths as the permanent regression guard.
 *
 * Seams this file pins (harness-owned WHAT confirmation):
 *   - guard.ts exports `blockedByDependencies(store, config)` — the never-silent half:
 *     ai-managed issues excluded from pollable because a dependency is unreleased, each
 *     naming the dependency ids and their CURRENT statuses. pollable itself gains the
 *     dependency filter (deps-empty issues keep today's behavior exactly).
 *   - runLoopLive's turn log names the blocked issues and what they wait on.
 *   - coordinator.runAll accepts an optional injected AgentRunner as an ADDITIVE 4th
 *     parameter (runIssue already takes one; runAll only lacked the pass-through) and
 *     re-evaluates eligibility as the chain progresses — a dependent issue never reaches
 *     the runner before its dependencies are released, and an issue that becomes eligible
 *     mid-call (its dep released by this very call) is picked up in the SAME call.
 *   - spawnIssues keeps rejecting unknown dependsOnIssues keys and manifest-internal
 *     cycles (BACKWARD-COMPAT AC, ④ AC-REGMT-004 shape: the existing design lint already
 *     enforces this, so its test is GREEN at baseline by design — once the guard/loop
 *     respect dependencies, that lint is what stands between a typo and a silent
 *     forever-blocked issue, so this pins it against regression).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, nowISO } from '../../src/store/store.js';
import { Issue } from '../../src/domain/schema.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../../src/config.js';
import { pollable } from '../../src/pipeline/execution/guard.js';
import { runAll } from '../../src/pipeline/coordinator.js';
import { runLoopLive } from '../../src/pipeline/execution/live.js';
import { planRoadmap, spawnSpecs, spawnIssues } from '../../src/planning/planning-tree.js';
import type { AgentRunner } from '../../src/agents/runner.js';
import type { BuildArtifact } from '../../src/domain/artifact.js';

// Missing-export erasure (⑥ precedent): the module exists, the new export does not (that
// IS the red) — a static named import of a missing export would break the repo's tsc gate.
const guard = (await import('../../src/pipeline/execution/guard.js')) as unknown as Record<
  string,
  (...a: never[]) => unknown
>;

const dirs: string[] = [];
function freshStore(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-dag-'));
  dirs.push(root);
  return new Store(root);
}

const CLAUDE: HarnessConfig = { ...DEFAULT_CONFIG, generator: 'claude' };
const MOCK: HarnessConfig = { ...DEFAULT_CONFIG, generator: 'mock', samples: 1, maxRepairs: 1 };

const contract = {
  productGoal: 'g', userStory: 'u', scope: { include: [], exclude: [] },
  acceptanceCriteria: [
    { id: 'AC-1', severity: 'blocker' as const, behavior: 'b', verification: { method: 'unit_test' as const, expected: ['x'] } },
  ],
  redLines: [],
};

function mkIssue(store: Store, id: string, o: { status?: string; agent?: string | null; deps?: string[] } = {}): void {
  store.addIssue(
    Issue.parse({
      id, type: 'harness', title: `t-${id}`, area: 'harness',
      status: o.status ?? 'contract-drafted', assignedAgent: o.agent === undefined ? 'claude' : o.agent,
      dependsOnIssues: o.deps ?? [], contract, createdAt: nowISO(), updatedAt: nowISO(),
    }),
  );
}

/** Always-approving runner that RECORDS, per dispatch, whether deps were released. */
function greenRunner(store: Store, dispatched: string[], violations: string[]): AgentRunner {
  return {
    agent: 'mock',
    generate: async (input) => {
      dispatched.push(input.issue.id);
      for (const dep of input.issue.dependsOnIssues) {
        if (store.getIssue(dep)?.status !== 'released') violations.push(`${input.issue.id} dispatched while ${dep} unreleased`);
      }
      const artifact: BuildArtifact = {
        branch: `agent/${input.issue.id.toLowerCase()}`, summary: 's',
        filesChanged: ['src/x.ts', 'test/x.test.ts'],
        satisfied: Object.fromEntries(input.contract.acceptanceCriteria.map((a) => [a.id, true])),
        buildPasses: true, typecheckPasses: true, unitTestsPass: true, apiTestsPass: true, hasTests: true,
        secretsLeaked: false, scopeViolations: [],
        quality: { codeQuality: 0.9, testQuality: 0.9, ux: 0.9, accessibility: 0.9 }, notes: [],
      };
      return artifact;
    },
  };
}

describe.skipIf(!process.env.ACCEPT_HARNESS)('dependency-ordered multi-issue drive (ISSUE-0018)', () => {
  it('ISSUE-0018/AC-DAG-001 an ai-managed issue with an unreleased dependency is not pollable, and the block is reported with the dependency and its status', () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-A', { status: 'planned', agent: null }); // the unreleased dependency
    mkIssue(store, 'ISSUE-B', { deps: ['ISSUE-A'] }); // ai-managed, waiting on A
    mkIssue(store, 'ISSUE-L', {}); // legacy: no deps — untouched behavior
    mkIssue(store, 'ISSUE-F', { status: 'closed', agent: null }); // a DECLINED dependency
    mkIssue(store, 'ISSUE-G', { deps: ['ISSUE-F'] }); // waits forever — must be visible, not silent

    const ids = pollable(store, CLAUDE).map((i) => i.id);
    expect(ids).toContain('ISSUE-L');
    expect(ids).not.toContain('ISSUE-B');
    expect(ids).not.toContain('ISSUE-G');

    const report = JSON.stringify((guard.blockedByDependencies as (s: Store, c: HarnessConfig) => unknown)(store, CLAUDE));
    expect(report).toContain('ISSUE-B');
    expect(report).toContain('ISSUE-A');
    expect(report).toContain('planned'); // the dependency's CURRENT status is named
    expect(report).toContain('ISSUE-G');
    expect(report).toContain('closed');
  });

  it('ISSUE-0018/AC-DAG-001 the live turn log names the blocked issue and what it waits on (never-silent)', async () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-A', { status: 'planned', agent: null });
    mkIssue(store, 'ISSUE-B', { deps: ['ISSUE-A'] });

    const lines: string[] = [];
    await runLoopLive(store, CLAUDE, store.root, {}, (m) => lines.push(m));
    const log = lines.join('\n');
    expect(log).toContain('ISSUE-B');
    expect(log).toContain('ISSUE-A');
  });

  it('ISSUE-0018/AC-DAG-002 a released dependency unblocks the dependent on the next poll — no human re-registration', () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-A', { status: 'planned', agent: null });
    mkIssue(store, 'ISSUE-B', { deps: ['ISSUE-A'] });
    expect(pollable(store, CLAUDE).map((i) => i.id)).not.toContain('ISSUE-B'); // blocked first

    store.setStatus('ISSUE-A', 'needs-human-review'); // the always-allowed escape hatch…
    store.setStatus('ISSUE-A', 'released'); // …then the human decision point
    expect(pollable(store, CLAUDE).map((i) => i.id)).toContain('ISSUE-B'); // unblocked, untouched
  });

  it('ISSUE-0018/AC-DAG-003 a chain A←B←C completes in dependency order in ONE deterministic runAll call', async () => {
    const store = freshStore();
    // Inserted in REVERSE order: a deps-blind snapshot loop would dispatch C first.
    mkIssue(store, 'ISSUE-C', { agent: 'mock', deps: ['ISSUE-B'] });
    mkIssue(store, 'ISSUE-B', { agent: 'mock', deps: ['ISSUE-A'] });
    mkIssue(store, 'ISSUE-A', { agent: 'mock' });

    const dispatched: string[] = [];
    const violations: string[] = [];
    const runAllInjected = runAll as unknown as (
      s: Store, c: HarnessConfig, log: (m: string) => void, runner?: AgentRunner,
    ) => Promise<{ issueId: string }[]>;
    const results = await runAllInjected(store, MOCK, () => {}, greenRunner(store, dispatched, violations));

    expect(dispatched).toEqual(['ISSUE-A', 'ISSUE-B', 'ISSUE-C']); // dependency order, not insertion order
    expect(violations).toEqual([]); // nothing reached the runner before its deps were released
    expect(results.map((r) => r.issueId)).toEqual(['ISSUE-A', 'ISSUE-B', 'ISSUE-C']);
    for (const id of ['ISSUE-A', 'ISSUE-B', 'ISSUE-C']) {
      expect(store.getIssue(id)!.status).toBe('released'); // the whole chain landed in one call
    }
  });

  it('ISSUE-0018/AC-DAG-004 spawn rejects unknown dependency keys and cycles loudly, spawning nothing; valid remapping is unchanged', () => {
    const roadmap = {
      vision: 'v', principles: [],
      epics: [{ id: 'EPIC-01', title: 'e', theme: 't', outcome: 'o', features: [{ id: 'FEAT-001', title: 'f', outcome: 'o' }] }],
    };
    const author = (manifest: string): { store: Store; specPath: string } => {
      const store = freshStore();
      planRoadmap(store, roadmap);
      spawnSpecs(store);
      const f = store.getFeature('FEAT-001')!;
      const specAbs = path.resolve(store.root, f.specPath!);
      fs.writeFileSync(path.join(specAbs, 'spec.md'), '# Spec\n\n## 受け入れ基準\n- **[AC-X-001]** behavior one\n- **[AC-X-002]** behavior two\n', 'utf8');
      const st = store.getSpecState(f.specPath!)!;
      st.approved = {
        signedCommitSha: 'deadbeef', specBlobGitSha: 'a', acceptanceBlobGitSha: 'b',
        acFingerprints: { 'AC-X-001': 'fp1', 'AC-X-002': 'fp2' }, systemRefs: [], approvedAcIds: ['AC-X-001', 'AC-X-002'],
      };
      st.signedAt = nowISO();
      fs.writeFileSync(path.join(specAbs, 'issues.yaml'), manifest, 'utf8');
      return { store, specPath: f.specPath! };
    };

    // (a) unknown key: neither a manifest key nor an existing store issue id.
    const unknown = author(`issues:
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
    expect(() => spawnIssues(unknown.store, unknown.specPath)).toThrow(/K-TYPO/);
    expect(unknown.store.db.issues).toHaveLength(0); // nothing partially spawned

    // (b) a cycle inside the manifest.
    const cyclic = author(`issues:
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
    expect(() => spawnIssues(cyclic.store, cyclic.specPath)).toThrow(/cycle|circular|循環/i);
    expect(cyclic.store.db.issues).toHaveLength(0);

    // (c) the valid shape keeps working: key remapped to the allocated id.
    const valid = author(`issues:
  - key: K-1
    title: first
    area: backend
    coversAcIds: [AC-X-001]
  - key: K-2
    title: second
    area: backend
    coversAcIds: [AC-X-002]
    dependsOnIssues: [K-1]
`);
    spawnIssues(valid.store, valid.specPath);
    const second = valid.store.db.issues.find((i) => i.title === 'second')!;
    const first = valid.store.db.issues.find((i) => i.title === 'first')!;
    expect(second.dependsOnIssues).toEqual([first.id]);
  });
});
