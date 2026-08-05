/**
 * mapPool — the bounded-concurrency primitive the parallel evaluator panel fans out on
 * (ADR-0006 E4). Verifies it never exceeds the limit, preserves input order, and propagates errors.
 */
import { describe, it, expect } from 'vitest';
import { mapPool } from '../src/pipeline/execution/pool.js';

const tick = () => new Promise<void>((r) => setTimeout(r, 5));

describe('mapPool: bounded concurrency', () => {
  it('never runs more than `limit` at once and preserves order', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // actually ran concurrently, not serialised
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16]); // input order, not completion order
  });

  it('handles an empty list and a limit larger than the list', async () => {
    expect(await mapPool([], 4, async (n) => n)).toEqual([]);
    expect(await mapPool([1, 2], 10, async (n) => n + 1)).toEqual([2, 3]);
  });

  it('propagates a worker error instead of dropping the item', async () => {
    await expect(mapPool([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    })).rejects.toThrow('boom');
  });
});
