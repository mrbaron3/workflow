/**
 * Concurrent dispatch under a finite cap (ISSUE-0019, AC-PAR-001/002).
 *
 * The live turn learns to drive multiple pollable issues at once, bounded by a finite,
 * configurable cap (`config.maxConcurrentIssues`, finite default; non-finite configs are
 * clamped — unbounded concurrency is a red line). The scheduling is decidable without
 * tmux through the ADDITIVE injectable issue-driver seam (`LiveOptions.driveIssue`): the
 * injected worker records start/finish, so overlap, cap adherence, starvation-freedom,
 * exactly-once dispatch, and dependency exclusion (FEAT-007 stays an invariant under
 * parallelism) are asserted from its record. Cap 1 reproduces today's sequential order
 * and results exactly (backward compat).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, nowISO } from '../src/store/store.js';
import { Issue } from '../src/domain/schema.js';
import { DEFAULT_CONFIG, resolveConcurrentIssueCap, type HarnessConfig } from '../src/config.js';
import { runLoopLive } from '../src/pipeline/execution/live.js';
import { computeMetrics } from '../src/metrics/metrics.js';

function freshStore(): Store {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-par-unit-')));
}

const contract = {
  productGoal: 'g',
  userStory: 'u',
  scope: { include: [], exclude: [] },
  acceptanceCriteria: [
    { id: 'AC-1', severity: 'blocker' as const, behavior: 'b', verification: { method: 'unit_test' as const, expected: ['x'] } },
  ],
  redLines: [],
};

function mkIssue(store: Store, id: string, o: { deps?: string[] } = {}): void {
  store.addIssue(
    Issue.parse({
      id,
      type: 'harness',
      title: `t-${id}`,
      area: 'harness',
      status: 'contract-drafted',
      assignedAgent: 'claude',
      dependsOnIssues: o.deps ?? [],
      contract,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    }),
  );
}

const cfgWithCap = (cap: number): HarnessConfig =>
  ({ ...DEFAULT_CONFIG, generator: 'claude', maxConcurrentIssues: cap });

interface DispatchEvent {
  id: string;
  type: 'start' | 'end';
}

/** Records every dispatched issue's in-flight interval; completion is async (20ms). */
function recordingWorker(events: DispatchEvent[], delayMs = 20) {
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
      issueId: issue.id,
      prId: `PR-${issue.id}`,
      verdict: 'approve' as const,
      status: 'needs-human-review',
      gateFailed: false,
      escalated: false,
      attempts: 1,
      exhausted: false,
      sampleCount: 1,
    };
  };
  return { worker, peaks };
}

describe('concurrent dispatch under a finite cap (AC-PAR-001)', () => {
  it('ISSUE-0019/AC-PAR-001 under cap 2 at least two issues overlap in flight, the cap is never exceeded, and every queued issue is driven exactly once', async () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-A');
    mkIssue(store, 'ISSUE-B');
    mkIssue(store, 'ISSUE-C');

    const events: DispatchEvent[] = [];
    const { worker, peaks } = recordingWorker(events);
    const results = await runLoopLive(store, cfgWithCap(2), store.root, { driveIssue: worker }, () => {});

    expect(Math.max(...peaks)).toBe(2); // overlap observed AND the cap held (never 3)
    // No starvation, no double dispatch: every queued issue started exactly once.
    const started = events.filter((e) => e.type === 'start').map((e) => e.id);
    expect([...started].sort()).toEqual(['ISSUE-A', 'ISSUE-B', 'ISSUE-C']);
    // Every issue's drive completed and reported a distinct identity (no collision).
    expect(results.map((r) => r.issueId).sort()).toEqual(['ISSUE-A', 'ISSUE-B', 'ISSUE-C']);
  });

  it('ISSUE-0019/AC-PAR-001 excess issues beyond the cap wait and run in queue order (no starvation)', async () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-C');
    mkIssue(store, 'ISSUE-A');
    mkIssue(store, 'ISSUE-B');
    mkIssue(store, 'ISSUE-D');

    const events: DispatchEvent[] = [];
    const { worker, peaks } = recordingWorker(events);
    await runLoopLive(store, cfgWithCap(2), store.root, { driveIssue: worker }, () => {});

    expect(Math.max(...peaks)).toBe(2);
    // Dispatch begins in stable queue (id) order even though insertion order differed,
    // and the overflow (C, D) starts only after a slot frees up.
    const started = events.filter((e) => e.type === 'start').map((e) => e.id);
    expect(started).toEqual(['ISSUE-A', 'ISSUE-B', 'ISSUE-C', 'ISSUE-D']);
    const firstEnd = events.findIndex((e) => e.type === 'end');
    const thirdStart = events.findIndex((e) => e.type === 'start' && e.id === 'ISSUE-C');
    expect(thirdStart).toBeGreaterThan(firstEnd); // C waited for a freed slot
  });

  it('ISSUE-0019/AC-PAR-001 cap 1 reproduces the sequential order and results exactly (backward compat)', async () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-B');
    mkIssue(store, 'ISSUE-A');

    const events: DispatchEvent[] = [];
    const { worker, peaks } = recordingWorker(events);
    const results = await runLoopLive(store, cfgWithCap(1), store.root, { driveIssue: worker }, () => {});

    expect(Math.max(...peaks)).toBe(1); // strictly sequential
    // Stable id order, fully serialized: A starts and ENDS before B starts.
    expect(events.map((e) => `${e.type}:${e.id}`)).toEqual([
      'start:ISSUE-A', 'end:ISSUE-A', 'start:ISSUE-B', 'end:ISSUE-B',
    ]);
    expect(results.map((r) => r.issueId)).toEqual(['ISSUE-A', 'ISSUE-B']); // result order too
  });

  it('ISSUE-0019/AC-PAR-001 the cap is configurable with a finite default, and even a config cannot make it unbounded', async () => {
    // A finite default exists: DEFAULT_CONFIG carries a positive finite integer cap.
    const dflt = DEFAULT_CONFIG.maxConcurrentIssues;
    expect(Number.isInteger(dflt)).toBe(true);
    expect(dflt).toBeGreaterThanOrEqual(1);
    // The resolver is the one reader of the raw config value: finite in, floored out;
    // non-finite in, finite default out (the red line lives here).
    expect(resolveConcurrentIssueCap(cfgWithCap(2.9))).toBe(2);
    expect(resolveConcurrentIssueCap(cfgWithCap(Number.POSITIVE_INFINITY))).toBe(dflt);

    // A config asking for unbounded concurrency (Infinity/NaN) is refused: the observed
    // peak stays finite — at most the queue length, never an uncontrolled fan-out — and
    // every issue still completes.
    for (const bogus of [Number.POSITIVE_INFINITY, Number.NaN]) {
      const store = freshStore();
      for (const id of ['ISSUE-A', 'ISSUE-B', 'ISSUE-C', 'ISSUE-D', 'ISSUE-E']) mkIssue(store, id);
      const events: DispatchEvent[] = [];
      const { worker, peaks } = recordingWorker(events, 5);
      const results = await runLoopLive(store, cfgWithCap(bogus), store.root, { driveIssue: worker }, () => {});
      expect(Math.max(...peaks)).toBeLessThanOrEqual(dflt); // clamped to the finite default
      expect(results).toHaveLength(5); // and the whole queue still drains
    }
  });

  it('ISSUE-0019/AC-PAR-001 a cap below 1 cannot silently starve the queue: it still drives everything, sequentially at worst', async () => {
    for (const bogus of [0, -3]) {
      const store = freshStore();
      mkIssue(store, 'ISSUE-A');
      mkIssue(store, 'ISSUE-B');
      const events: DispatchEvent[] = [];
      const { worker, peaks } = recordingWorker(events, 5);
      const results = await runLoopLive(store, cfgWithCap(bogus), store.root, { driveIssue: worker }, () => {});
      expect(results).toHaveLength(2); // never "cap 0 → nothing runs"
      expect(Math.max(...peaks)).toBe(1); // clamped up to exactly 1, not more
    }
  });
});

describe('dependency exclusion under parallelism (AC-PAR-002)', () => {
  it('ISSUE-0019/AC-PAR-002 an issue with an unreleased dependency never enters the in-flight set while independent issues run concurrently, and the block stays reported', async () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-A');
    mkIssue(store, 'ISSUE-B');
    mkIssue(store, 'ISSUE-D', { deps: ['ISSUE-A'] }); // A is contract-drafted, NOT released

    const events: DispatchEvent[] = [];
    const { worker, peaks } = recordingWorker(events);
    const lines: string[] = [];
    await runLoopLive(store, cfgWithCap(2), store.root, { driveIssue: worker }, (l) => lines.push(l));

    expect(events.map((e) => e.id)).not.toContain('ISSUE-D'); // never in the in-flight set
    expect(Math.max(...peaks)).toBe(2); // the dependency-free issues still parallelised
    const log = lines.join('\n');
    expect(log).toContain('ISSUE-D'); // …and the FEAT-007 block report is intact, never silent
    expect(log).toContain('ISSUE-A'); // naming what it waits on
  });

  it('ISSUE-0019/AC-PAR-002 a blocked issue is a poll-time hold, not a state transition, even in a parallel turn', async () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-A');
    mkIssue(store, 'ISSUE-D', { deps: ['ISSUE-A'] });

    const { worker } = recordingWorker([]);
    await runLoopLive(store, cfgWithCap(3), store.root, { driveIssue: worker }, () => {});

    expect(store.getIssue('ISSUE-D')!.status).toBe('contract-drafted'); // untouched
  });
});

describe('per-turn concurrency instruments (AC-PAR-003)', () => {
  it('ISSUE-0020/AC-PAR-003 the instruments are null before any turn is recorded (unobserved ≠ 0)', () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-A');

    const m = computeMetrics(store);
    expect(m.lastTurnPeakConcurrency).toBeNull();
    expect(m.lastTurnIssuesDriven).toBeNull();
    expect(m.lastTurnCap).toBeNull();
  });

  it('ISSUE-0020/AC-PAR-003 a live turn persists its concurrency facts in the store — a re-opened store still surfaces them in metrics', async () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-A');
    mkIssue(store, 'ISSUE-B');

    const { worker } = recordingWorker([]);
    await runLoopLive(store, cfgWithCap(2), store.root, { driveIssue: worker }, () => {});

    // The facts are store facts (never log-only): reopen from disk, then read.
    const reopened = new Store(store.root);
    const m = computeMetrics(reopened);
    expect(m.lastTurnPeakConcurrency).toBe(2);
    expect(m.lastTurnIssuesDriven).toBe(2);
    expect(m.lastTurnCap).toBe(2);
  });

  it('ISSUE-0020/AC-PAR-003 the recorded peak is measured at the dispatch seam: cap 1 records peak 1 even with a longer queue', async () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-A');
    mkIssue(store, 'ISSUE-B');
    mkIssue(store, 'ISSUE-C');

    const { worker } = recordingWorker([]);
    await runLoopLive(store, cfgWithCap(1), store.root, { driveIssue: worker }, () => {});

    const m = computeMetrics(new Store(store.root));
    expect(m.lastTurnPeakConcurrency).toBe(1); // sequential turn observed as sequential
    expect(m.lastTurnIssuesDriven).toBe(3); // every queued issue still counted
    expect(m.lastTurnCap).toBe(1);
  });

  it('ISSUE-0020/AC-PAR-003 the peak is an observation, not the cap echoed back: cap 4 over 2 overlapping issues records peak 2', async () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-A');
    mkIssue(store, 'ISSUE-B');

    // Cap 4 but only 2 issues can ever be in flight: the achievable concurrency is
    // strictly below the cap, so a recorder that echoes the cap (or min(cap, queue))
    // instead of measuring is caught here.
    const { worker, peaks } = recordingWorker([]);
    await runLoopLive(store, cfgWithCap(4), store.root, { driveIssue: worker }, () => {});

    expect(Math.max(...peaks)).toBe(2); // the two issues really did overlap
    const m = computeMetrics(new Store(store.root));
    expect(m.lastTurnPeakConcurrency).toBe(2); // measured maximum, NOT the configured 4
    expect(m.lastTurnCap).toBe(4); // the cap is surfaced separately, distinguishable
    expect(m.lastTurnIssuesDriven).toBe(2);
  });

  it('ISSUE-0020/AC-PAR-003 observed zero stays distinct from unobserved: an empty-queue turn surfaces 0/0 with its cap, never null', async () => {
    const store = freshStore(); // no issues at all — the pollable queue is empty

    const events: DispatchEvent[] = [];
    const { worker } = recordingWorker(events);
    await runLoopLive(store, cfgWithCap(3), store.root, { driveIssue: worker }, () => {});

    expect(events).toHaveLength(0); // nothing was dispatched — the zeros are observations
    const m = computeMetrics(new Store(store.root));
    expect(m.lastTurnPeakConcurrency).toBe(0); // a turn ran and saw 0 in flight — not null
    expect(m.lastTurnIssuesDriven).toBe(0); // 0 driven is a fact, not "never observed"
    expect(m.lastTurnCap).toBe(3); // the turn's resolved cap is still recorded
  });

  it('ISSUE-0020/AC-PAR-003 the LAST turn wins: a later turn overwrites the surfaced instruments, not the history', async () => {
    const store = freshStore();
    mkIssue(store, 'ISSUE-A');
    mkIssue(store, 'ISSUE-B');

    const { worker } = recordingWorker([]);
    await runLoopLive(store, cfgWithCap(2), store.root, { driveIssue: worker }, () => {});
    // Second turn under cap 1: the injected worker never moves issue status, so both
    // issues are still pollable and get re-driven.
    const { worker: w2 } = recordingWorker([]);
    await runLoopLive(store, cfgWithCap(1), store.root, { driveIssue: w2 }, () => {});

    const m = computeMetrics(new Store(store.root));
    expect(m.lastTurnPeakConcurrency).toBe(1); // the latest turn's facts
    expect(m.lastTurnCap).toBe(1);
  });
});
