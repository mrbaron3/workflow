import { describe, expect, it } from 'vitest';
import type { PostgresControlStore } from '../src/control-store/store.js';
import type { ExecutionGuardVerdict, Lease } from '../src/control-store/types.js';
import { RunnerLeaseFence } from '../src/runner/guard.js';

function lease(): Lease {
  return {
    id: 'ad837db2-30d7-4788-a56f-00056f5d550e',
    token: 'bd837db2-30d7-4788-a56f-00056f5d550e',
    workerId: 'runner-1',
    attemptId: 'cd837db2-30d7-4788-a56f-00056f5d550e',
    attemptNumber: 1,
    expiresAt: '2026-07-25T00:10:00.000Z',
    job: {
      contractVersion: 1,
      id: 'db837db2-30d7-4788-a56f-00056f5d550e',
      registrationId: 'ca3126a8-b83f-4698-90af-462523880c20',
      registrationVersion: 1,
      source: { kind: 'manual', key: 'test' },
      idempotencyKey: 'test',
      jobType: 'agentops.runner',
      payload: {},
      status: 'leased',
      createdAt: '2026-07-25T00:00:00.000Z',
    },
  };
}

function store(verdict: ExecutionGuardVerdict): PostgresControlStore {
  return {
    assertExecutionGuard: async () => verdict,
  } as unknown as PostgresControlStore;
}

describe('runner lease fence', () => {
  const allowed: ExecutionGuardVerdict = {
    ok: true,
    reason: null,
    registration: null,
    jobId: lease().job.id,
    leaseExpiresAt: '2026-07-25T00:10:00.000Z',
  };

  it('requires a fresh single-use DB permit at every synchronous side-effect seam', async () => {
    const fence = new RunnerLeaseFence(store(allowed), lease(), 'runner-1', 1_000);
    await fence.arm('push');
    expect(() => fence.consume('push')).not.toThrow();
    expect(() => fence.consume('push')).toThrow(/absent/);
  });

  it('queues independently authorized permits for consecutive release mutations', async () => {
    const fence = new RunnerLeaseFence(store(allowed), lease(), 'runner-1', 1_000);
    await fence.arm('release');
    await fence.arm('release');
    expect(() => fence.consume('release')).not.toThrow();
    expect(() => fence.consume('release')).not.toThrow();
    expect(() => fence.consume('release')).toThrow(/absent/);
  });

  it('fails closed but makes a merely expired permit safely retryable', async () => {
    const fence = new RunnerLeaseFence(store(allowed), lease(), 'runner-1', 0);
    await fence.arm('merge');
    await new Promise((resolve) => setTimeout(resolve, 1));
    const error = (() => {
      try {
        fence.consume('merge');
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toMatchObject({
      code: 'lease_lost',
      retryable: true,
      boundary: 'merge',
    });
  });

  it('fails closed and stays stopped after stale Registration or heartbeat loss', async () => {
    const stale = new RunnerLeaseFence(store({
      ...allowed,
      ok: false,
      reason: 'registration_version_stale',
    }), lease(), 'runner-1');
    await expect(stale.arm('merge')).rejects.toMatchObject({
      code: 'registration_stale',
      boundary: 'merge',
    });
    await expect(stale.arm('provider')).rejects.toMatchObject({
      code: 'lease_lost',
    });

    const lost = new RunnerLeaseFence(store(allowed), lease(), 'runner-1');
    lost.markLost('heartbeat rejected');
    await expect(lost.arm('release')).rejects.toMatchObject({
      code: 'lease_lost',
      boundary: 'release',
    });
  });
});
