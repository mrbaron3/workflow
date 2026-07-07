/**
 * Env-gated acceptance grader for ISSUE-0007 "Keep working sessions alive to a finite
 * active cap and collect late findings" — spec
 * docs/specs/active-session-liveness-and-late-findings-collection (AC-LIVE-001..003).
 *
 * RED at baseline BY DESIGN, collected only under ACCEPT_HARNESS=1 (ADR-0007 I3): the
 * drive's real Claude session must make it pass but cannot edit it
 * (config.target.protectedPaths). After the fix is human-approved and released, drop the
 * skipIf so it becomes a permanent regression guard (per the promoted siblings here).
 *
 * Seams this file pins (harness-owned WHAT confirmation):
 *   - monitorLiveness opts gains `activeCapMs` (finite ceiling for ACTIVE sessions) plus
 *     injectable `clock` / `capture` / `sentinelExists` / `sleep` — so the ⑤ failure
 *     (a working review timed out at hardCap; its late findings lost) is decidable
 *     deterministically: active past hardCap is NOT a timeout until activeCapMs.
 *   - perspective-session exports `collectFindings(jobs, statuses, evalRoot, opts)` — the
 *     tmux-free phase-3 collection that consults SENTINEL EXISTENCE at collection time,
 *     not just the recorded status, with the read-only (dirty-checkout) guard injectable.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorLiveness } from '../../src/pipeline/execution/tmux.js';

// Dynamic import with type erasure: `collectFindings` does not exist at baseline (that IS the
// red), and a static named import of a missing export would break the repo's tsc gate for
// everyone. Undefined at baseline → the AC-LIVE-003 test throws (red); exported by the build →
// it runs. tsc stays green either way.
const perspectiveSession = (await import('../../src/pipeline/execution/perspective-session.js')) as unknown as Record<string, (...args: never[]) => unknown>;

type LivenessOpts = Parameters<typeof monitorLiveness>[2];

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-live-'));
  dirs.push(d);
  return d;
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

/**
 * Drive monitorLiveness on a virtual clock: `sleep` advances time, `capture` models pane
 * activity, `sentinelExists` models the findings file appearing at `sentinelAt` (virtual ms).
 * Magnitudes are tiny; only the RELATIONSHIPS matter (sentinel after hardCap, before activeCap).
 */
async function runLiveness(o: {
  paneActive: boolean;
  sentinelAt?: number;
  idleMs?: number;
  hardCapMs?: number;
  activeCapMs?: number;
}): Promise<string> {
  let t = 0;
  const opts = {
    idleMs: o.idleMs ?? 50,
    hardCapMs: o.hardCapMs ?? 100,
    pollMs: 5,
    activeCapMs: o.activeCapMs ?? 10_000,
    clock: () => t,
    sleep: async (ms: number) => { t += ms; },
    capture: () => (o.paneActive ? `pane-at-${t}` : 'static-pane'),
    sentinelExists: () => o.sentinelAt !== undefined && t >= o.sentinelAt,
  } as LivenessOpts;
  return monitorLiveness('ao-fake-session', '/nonexistent/sentinel.json', opts);
}

describe.skipIf(!process.env.ACCEPT_HARNESS)('active-session liveness + late findings collection (ISSUE-0007)', () => {
  it('ISSUE-0007/AC-LIVE-001 an actively-working session survives past hardCap and completes when the sentinel appears', async () => {
    // Sentinel appears well AFTER hardCapMs (100) but before activeCapMs (10_000) — the ⑤ shape.
    await expect(runLiveness({ paneActive: true, sentinelAt: 600 })).resolves.toBe('completed');
  });

  it('ISSUE-0007/AC-LIVE-002 finiteness and stuck detection hold: active past activeCap → timeout; idle → stuck', async () => {
    await expect(runLiveness({ paneActive: true })).resolves.toBe('timeout'); // never a silent infinite wait
    await expect(runLiveness({ paneActive: false })).resolves.toBe('stuck'); // idle semantics unchanged
  });

  it('ISSUE-0007/AC-LIVE-003 findings that exist at collection time are collected even for a stuck/timeout review — dirty checkouts still discarded', () => {
    const root = tmpDir();
    const evalRoot = path.join(root, 'central');
    const mkJob = (key: string) => {
      const reviewWt = path.join(root, `rw-${key}`);
      const sentinel = path.join(reviewWt, '.agentops', 'eval', key, 'findings.json');
      fs.mkdirSync(path.dirname(sentinel), { recursive: true });
      fs.writeFileSync(sentinel, JSON.stringify({ verdict: 'approve', score: 1, findings: [] }), 'utf8');
      return { key, reviewWt, sentinel };
    };
    const late = mkJob('testQuality'); // judged stuck, but its findings exist NOW (the ⑤ race)
    const dirty = mkJob('security'); // also late — but it edited its checkout

    const collectFindings = perspectiveSession['collectFindings'] as (
      jobs: { key: string; reviewWt: string; sentinel: string }[],
      statuses: string[],
      evalRoot: string,
      opts?: { changed?: (wt: string) => string[] },
    ) => { completed: string[]; touchedCode: string[] };
    expect(collectFindings, 'perspective-session must export collectFindings').toBeTypeOf('function');

    const res = collectFindings([late, dirty], ['stuck', 'stuck'], evalRoot, {
      changed: (wt: string) => (wt === dirty.reviewWt ? ['src/hacked.ts'] : []),
    });

    expect(fs.existsSync(path.join(evalRoot, 'testQuality', 'findings.json'))).toBe(true); // late evidence collected
    expect(res.completed).toContain('testQuality');
    expect(fs.existsSync(path.join(evalRoot, 'security', 'findings.json'))).toBe(false); // read-only guard survives
    expect(res.touchedCode).toContain('security');
  });
});
