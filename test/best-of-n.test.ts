/**
 * runBestOfN (ADR-0006 E5): best-of-N orchestration over a runSample seam. Default is
 * first-approve-stop (ship the first working build, cheapest); measure mode runs ALL n samples to
 * completion so pass@k/pass^k have the full sample set. The winner is the first approver either way.
 */
import { describe, it, expect } from 'vitest';
import { runBestOfN, type SampleOutcome } from '../src/pipeline/execution/loop.js';

function sample(sampleIndex: number, approved: boolean): SampleOutcome {
  return {
    sampleIndex, prId: `PR-${sampleIndex}`, approved,
    verdict: approved ? 'approve' : 'request_changes', status: 'needs-human-review',
    gateFailed: false, escalated: false, attempts: 1, exhausted: !approved, worktree: `/wt/${sampleIndex}`,
  };
}

/** A runSample that approves exactly at `approveAt` (null = never), counting how many samples ran. */
function stagedRunSample(approveAt: number | null): { run: (s: number) => Promise<SampleOutcome>; count: () => number } {
  let ran = 0;
  return {
    run: async (s: number) => { ran++; return sample(s, approveAt !== null && s === approveAt); },
    count: () => ran,
  };
}

describe('runBestOfN: first-approve-stop (default)', () => {
  it('stops as soon as a sample approves — does not pay for the rest', async () => {
    const staged = stagedRunSample(1); // sample 1 approves
    const { samples, winner } = await runBestOfN(4, false, staged.run);
    expect(staged.count()).toBe(2); // ran samples 0 and 1, then stopped
    expect(samples.length).toBe(2);
    expect(winner?.sampleIndex).toBe(1);
  });

  it('runs the full budget when nothing approves, and reports no winner', async () => {
    const staged = stagedRunSample(null);
    const { samples, winner } = await runBestOfN(3, false, staged.run);
    expect(staged.count()).toBe(3);
    expect(samples.length).toBe(3);
    expect(winner).toBeNull();
  });
});

describe('runBestOfN: measure mode', () => {
  it('runs ALL n samples even after one approves (so pass@k/pass^k see every sample)', async () => {
    const staged = stagedRunSample(1); // sample 1 approves early
    const { samples, winner } = await runBestOfN(4, true, staged.run);
    expect(staged.count()).toBe(4); // did NOT stop at the first approve
    expect(samples.length).toBe(4);
    expect(winner?.sampleIndex).toBe(1); // winner is still the FIRST approver
  });

  it('the winner is the first approver even when a later sample also approves', async () => {
    let ran = 0;
    const { winner } = await runBestOfN(3, true, async (s) => { ran++; return sample(s, s >= 1); }); // 1 and 2 approve
    expect(ran).toBe(3);
    expect(winner?.sampleIndex).toBe(1);
  });
});

describe('runBestOfN: single sample (the real-backend default)', () => {
  it('drives exactly one sample', async () => {
    const staged = stagedRunSample(0);
    const { samples, winner } = await runBestOfN(1, false, staged.run);
    expect(staged.count()).toBe(1);
    expect(samples.length).toBe(1);
    expect(winner?.sampleIndex).toBe(0);
  });

  it('treats n<1 as one sample (never zero)', async () => {
    const staged = stagedRunSample(null);
    const { samples } = await runBestOfN(0, false, staged.run);
    expect(samples.length).toBe(1);
  });
});
