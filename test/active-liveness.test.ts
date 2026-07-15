/**
 * ISSUE-0007 — keep WORKING sessions alive up to the finite active ceiling, and collect
 * findings that exist at collection time even for a stuck/timeout review.
 *
 * The grounded failure this pins (⑤): a review that kept working 1h26m past its 10-min
 * wall-clock cap was declared timeout and its already-written findings were thrown away.
 * Only idleMs and activeCapMs decide outcomes now, and both are pinned on a VIRTUAL clock
 * via monitorLiveness's injectable seams (clock / sleep / capture / sentinelExists);
 * collection is pinned through the tmux-free collectFindings with an injectable
 * dirty-checkout guard. Magnitudes are tiny — only the RELATIONSHIPS matter (sentinel /
 * idle transition late in the watch, before activeCap).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorLiveness } from '../src/pipeline/execution/tmux.js';
import { collectFindings, findingsPath, type ReviewJob } from '../src/pipeline/execution/perspective-session.js';

/** Drive monitorLiveness on a virtual clock: `sleep` advances time, `capture` models pane
 *  activity (static from `idleAfter` on, when given — an active session that then dies),
 *  `sentinelExists` models the findings file appearing at `sentinelAt` (virtual ms). */
async function runLiveness(o: {
  paneActive: boolean;
  sentinelAt?: number;
  activeCapMs: number;
  idleMs?: number;
  idleAfter?: number;
  onDone?: (t: number) => void;
}): Promise<string> {
  let t = 0;
  const outcome = await monitorLiveness('ao-virtual-session', '/virtual/findings.json', {
    idleMs: o.idleMs ?? 50,
    pollMs: 5,
    activeCapMs: o.activeCapMs,
    clock: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    capture: () =>
      !o.paneActive || (o.idleAfter !== undefined && t >= o.idleAfter) ? 'static-pane' : `pane-at-${t}`,
    sentinelExists: () => o.sentinelAt !== undefined && t >= o.sentinelAt,
  });
  o.onDone?.(t);
  return outcome;
}

describe('monitorLiveness — a working session lives to the finite active ceiling (ISSUE-0007)', () => {
  it('ISSUE-0007/AC-LIVE-001 an actively-working session is not timed out early and completes when the sentinel appears', async () => {
    // The ⑤ shape: the sentinel lands long past the 100-magnitude timings where the old
    // per-session wall-clock cap used to fire, but before the finite activeCapMs ceiling.
    let endedAt = 0;
    await expect(
      runLiveness({ paneActive: true, sentinelAt: 600, activeCapMs: 10_000, onDone: (t) => (endedAt = t) }),
    ).resolves.toBe('completed');
    expect(endedAt).toBeGreaterThanOrEqual(600); // it genuinely kept working until the sentinel, uninterrupted
  });

  it('ISSUE-0007/AC-LIVE-002 finiteness and stuck detection hold: active past activeCap → timeout, idle pane → stuck', async () => {
    let endedAt = 0;
    await expect(
      runLiveness({ paneActive: true, activeCapMs: 10_000, onDone: (t) => (endedAt = t) }),
    ).resolves.toBe('timeout');
    expect(endedAt).toBeLessThanOrEqual(10_000 + 10); // the ceiling binds within one poll — never an unbounded wait
    await expect(runLiveness({ paneActive: false, activeCapMs: 10_000 })).resolves.toBe('stuck');
  });

  it('ISSUE-0007/AC-LIVE-002 going idle deep into the watch surfaces as stuck near idleAfter+idleMs — not deferred to the activeCap timeout', async () => {
    // The state space this feature opened: a session works well past the old cap's scale
    // (idleAfter=300 ≫ 100) and THEN dies. It must surface as stuck at idleAfter+idleMs (355),
    // not sit mislabelled until the 10_000 ceiling turns it into a timeout.
    let endedAt = 0;
    await expect(
      runLiveness({ paneActive: true, idleAfter: 300, activeCapMs: 10_000, onDone: (t) => (endedAt = t) }),
    ).resolves.toBe('stuck');
    expect(endedAt).toBeGreaterThanOrEqual(300 + 50); // idle for the full idleMs after the transition…
    expect(endedAt).toBeLessThanOrEqual(300 + 50 + 10); // …then surfaced within one poll, far below the ceiling
  });
});

// --- late findings collection (tmux-free phase 3) -----------------------------

const dirs: string[] = [];
function tmpRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-late-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A review job whose worktree holds a findings.json sentinel (unless sentinel: false). */
function mkJob(root: string, key: string, o: { sentinel?: boolean } = {}): ReviewJob {
  const reviewWt = path.join(root, `rw-${key}`);
  const sentinel = path.join(reviewWt, '.agentops', 'eval', key, 'findings.json');
  const prompt = path.join(reviewWt, '.agentops', 'eval', key, 'PROMPT.md');
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  if (o.sentinel !== false) fs.writeFileSync(sentinel, JSON.stringify({ verdict: 'approve', score: 1, findings: [] }), 'utf8');
  return { key, reviewWt, prompt, sentinel };
}

describe('collectFindings — collection consults sentinel existence at collection time (ISSUE-0007)', () => {
  it('ISSUE-0007/AC-LIVE-003 findings that exist at collection time are collected for a stuck/timeout review, like completed ones', () => {
    const root = tmpRoot();
    const evalRoot = path.join(root, 'central');
    const done = mkJob(root, 'codeQuality'); // completed normally
    const late = mkJob(root, 'testQuality'); // judged timeout, but its findings exist NOW (the ⑤ race)
    const silent = mkJob(root, 'ux', { sentinel: false }); // stuck with nothing to collect

    const logs: string[] = [];
    const res = collectFindings([done, late, silent], ['completed', 'timeout', 'stuck'], evalRoot, {
      changed: () => [],
      log: (m) => logs.push(m),
    });

    expect(res.completed).toEqual(['codeQuality', 'testQuality']);
    expect(fs.existsSync(findingsPath(evalRoot, 'codeQuality'))).toBe(true);
    expect(fs.existsSync(findingsPath(evalRoot, 'testQuality'))).toBe(true); // late evidence feeds the panel
    expect(logs.join('\n')).toContain('late findings collected from a timeout review'); // the review's REAL failure mode, not a collapsed 'stuck'
    expect(fs.existsSync(findingsPath(evalRoot, 'ux'))).toBe(false); // still escalates via the missing-file path
    expect(res.touchedCode).toEqual([]);
  });

  it('ISSUE-0007/AC-LIVE-003 the read-only guard survives late collection: a dirty checkout is discarded, not collected', () => {
    const root = tmpRoot();
    const evalRoot = path.join(root, 'central');
    const dirty = mkJob(root, 'security'); // findings exist, but the review edited its checkout
    const clean = mkJob(root, 'accessibility');

    const res = collectFindings([dirty, clean], ['stuck', 'completed'], evalRoot, {
      changed: (wt) => (wt === dirty.reviewWt ? ['src/hacked.ts'] : []),
    });

    expect(res.touchedCode).toEqual(['security']);
    expect(fs.existsSync(findingsPath(evalRoot, 'security'))).toBe(false); // read-only guard survives
    expect(res.completed).toEqual(['accessibility']);
    expect(fs.existsSync(findingsPath(evalRoot, 'accessibility'))).toBe(true);
  });
});
