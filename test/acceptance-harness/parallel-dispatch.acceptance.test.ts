/**
 * Env-gated acceptance grader for ISSUE-0019/ISSUE-0020 — spec
 * docs/specs/parallel-spec-execution-with-grounded-skill-authoring (AC-PAR-001..003,
 * FEAT-008 / M2 後半). TWO issues share this spec: 0019 = concurrent dispatch
 * (AC-PAR-001/002), 0020 = per-turn resource instruments (AC-PAR-003, depends on 0019) —
 * the first dependency-chained decomposition, so DRIVING it is itself the grounded
 * observation of FEAT-007.
 *
 * Red at baseline BY DESIGN, collected only under ACCEPT_HARNESS=1 (ADR-0007 I3). After
 * each build is human-approved and released, the skipIf is dropped and this file stays in
 * protectedPaths as the permanent regression guard.
 *
 * Seams this file pins (harness-owned WHAT confirmation):
 *   - runLoopLive accepts an ADDITIVE injectable issue-driver (LiveOptions.driveIssue) so
 *     concurrency scheduling is decidable without tmux: the injected worker records start/
 *     finish, letting overlap / cap / starvation / dependency-exclusion be asserted.
 *   - a finite, configurable concurrent-issue cap with a finite default; cap 1 reproduces
 *     today's sequential order exactly.
 *   - per-turn concurrency FACTS persist in the store (never log-only) and surface in
 *     computeMetrics as instruments (peak concurrency, issues driven, cap) — null when no
 *     turn has been recorded (unobserved ≠ 0).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, nowISO } from '../../src/store/store.js';
import { Issue } from '../../src/domain/schema.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../../src/config.js';
import { runLoopLive } from '../../src/pipeline/execution/live.js';
import { computeMetrics } from '../../src/metrics/metrics.js';

const dirs: string[] = [];
function freshStore(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-par-'));
  dirs.push(root);
  return new Store(root);
}

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

/** Records the in-flight interval of every dispatched issue; completion is async. */
function recordingWorker(events: { id: string; type: 'start' | 'end' }[], delayMs = 20) {
  let inFlight = 0;
  const peaks: number[] = [];
  const worker = async (issue: Issue) => {
    inFlight += 1;
    peaks.push(inFlight);
    events.push({ id: issue.id, type: 'start' });
    await new Promise((r) => setTimeout(r, delayMs));
    events.push({ id: issue.id, type: 'end' });
    inFlight -= 1;
    return {
      issueId: issue.id, prId: `PR-${issue.id}`, verdict: 'approve', status: 'needs-human-review',
      gateFailed: false, escalated: false, attempts: 1, exhausted: false, sampleCount: 1,
    };
  };
  return { worker, peaks };
}

type LiveWithDriver = (
  store: Store, config: HarnessConfig, root: string,
  opts: Record<string, unknown>, log: (m: string) => void,
) => Promise<unknown[]>;

const cfgWithCap = (cap: number): HarnessConfig =>
  ({ ...DEFAULT_CONFIG, generator: 'claude', maxConcurrentIssues: cap }) as HarnessConfig;

describe.skipIf(!process.env.ACCEPT_HARNESS)('parallel dispatch under a finite cap (ISSUE-0019 / ISSUE-0020)', () => {
  it('ISSUE-0019/AC-PAR-001 two pollable issues overlap in flight under cap 2, the cap is never exceeded, and every queued issue completes', async () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-A');
    mkIssue(store, 'ISSUE-B');
    mkIssue(store, 'ISSUE-C');

    const events: { id: string; type: 'start' | 'end' }[] = [];
    const { worker, peaks } = recordingWorker(events);
    const results = await (runLoopLive as unknown as LiveWithDriver)(
      store, cfgWithCap(2), store.root, { driveIssue: worker }, () => {},
    );

    expect(Math.max(...peaks)).toBe(2); // overlap happened AND the cap held (never 3)
    expect(results).toHaveLength(3); // the third waited its turn — no starvation
    const started = events.filter((e) => e.type === 'start').map((e) => e.id).sort();
    expect(started).toEqual(['ISSUE-A', 'ISSUE-B', 'ISSUE-C']);
  });

  it('ISSUE-0019/AC-PAR-001 cap 1 reproduces the sequential order exactly (backward compat)', async () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-B');
    mkIssue(store, 'ISSUE-A');

    const events: { id: string; type: 'start' | 'end' }[] = [];
    const { worker, peaks } = recordingWorker(events);
    await (runLoopLive as unknown as LiveWithDriver)(store, cfgWithCap(1), store.root, { driveIssue: worker }, () => {});

    expect(Math.max(...peaks)).toBe(1); // strictly sequential
    // stable id order, fully serialized: A starts and ENDS before B starts.
    expect(events.map((e) => `${e.type}:${e.id}`)).toEqual([
      'start:ISSUE-A', 'end:ISSUE-A', 'start:ISSUE-B', 'end:ISSUE-B',
    ]);
  });

  it('ISSUE-0019/AC-PAR-002 an issue with an unreleased dependency never enters the in-flight set, and the block stays reported', async () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-A');
    mkIssue(store, 'ISSUE-B');
    mkIssue(store, 'ISSUE-D', { deps: ['ISSUE-A'] }); // A is contract-drafted, NOT released

    const events: { id: string; type: 'start' | 'end' }[] = [];
    const { worker } = recordingWorker(events);
    const lines: string[] = [];
    await (runLoopLive as unknown as LiveWithDriver)(store, cfgWithCap(2), store.root, { driveIssue: worker }, (l) => lines.push(l));

    expect(events.map((e) => e.id)).not.toContain('ISSUE-D'); // never dispatched
    const log = lines.join('\n');
    expect(log).toContain('ISSUE-D'); // …but never silent either (FEAT-007 report intact)
    expect(log).toContain('ISSUE-A');
  });

  it('ISSUE-0020/AC-PAR-003 the turn records its concurrency facts in the store and the instruments surface in metrics; unobserved is null', async () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-A');
    mkIssue(store, 'ISSUE-B');

    // Unobserved first: no parallel turn recorded yet → null, never 0 or 1.
    const before = computeMetrics(store) as unknown as Record<string, unknown>;
    expect(before.lastTurnPeakConcurrency).toBeNull();

    const { worker } = recordingWorker([]);
    await (runLoopLive as unknown as LiveWithDriver)(store, cfgWithCap(2), store.root, { driveIssue: worker }, () => {});

    // The facts persist in the STORE (ADR-0001) — a re-opened store still knows them.
    const reopened = new Store(store.root);
    const m = computeMetrics(reopened) as unknown as Record<string, unknown>;
    expect(m.lastTurnPeakConcurrency).toBe(2);
    expect(m.lastTurnIssuesDriven).toBe(2);
    expect(m.concurrencyCap).toBe(2);
  });
});
