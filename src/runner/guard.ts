import { performance } from 'node:perf_hooks';
import type { PostgresControlStore } from '../control-store/store.js';
import type { Lease, RunnerCriticalBoundary } from '../control-store/types.js';
import { RunnerExecutionError } from './errors.js';

/**
 * DB-backed authorization fence plus a short-lived in-process permit consumed
 * at the exact synchronous GitHub side-effect call site.
 */
export class RunnerLeaseFence {
  private readonly permits = new Map<RunnerCriticalBoundary, number>();
  private lostReason: string | null = null;

  constructor(
    private readonly store: PostgresControlStore,
    readonly lease: Lease,
    readonly workerId: string,
    private readonly maxPermitAgeMs = 5_000,
  ) {}

  markLost(reason: string): void {
    this.lostReason ??= reason;
    this.permits.clear();
  }

  assertLive(boundary: RunnerCriticalBoundary): void {
    if (this.lostReason) {
      throw new RunnerExecutionError(
        'lease_lost',
        `runner stopped at ${boundary}: ${this.lostReason}`,
        false,
        boundary,
      );
    }
  }

  async arm(boundary: RunnerCriticalBoundary): Promise<void> {
    this.assertLive(boundary);
    const verdict = await this.store.assertExecutionGuard({
      token: this.lease.token,
      workerId: this.workerId,
      boundary,
    });
    if (!verdict.ok) {
      this.markLost(verdict.reason ?? 'execution guard denied');
      const stale = verdict.reason?.startsWith('registration_') ?? false;
      throw new RunnerExecutionError(
        stale ? 'registration_stale' : 'lease_lost',
        `runner ${boundary} guard denied: ${verdict.reason ?? 'unknown reason'}`,
        false,
        boundary,
      );
    }
    this.permits.set(boundary, performance.now());
  }

  /**
   * Called synchronously inside push/merge/release adapters. The DB decision is
   * single-use and expires quickly, so a stage cannot reuse an old lease check.
   */
  consume(boundary: RunnerCriticalBoundary): void {
    this.assertLive(boundary);
    const armedAt = this.permits.get(boundary);
    this.permits.delete(boundary);
    if (armedAt === undefined || performance.now() - armedAt > this.maxPermitAgeMs) {
      throw new RunnerExecutionError(
        'lease_lost',
        `runner ${boundary} permit is absent or expired`,
        false,
        boundary,
      );
    }
  }
}
