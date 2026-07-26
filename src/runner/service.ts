import type { PostgresControlStore } from '../control-store/store.js';
import { Worker } from 'node:worker_threads';
import {
  JobEnvelopeContract,
  RunnerJobPayloadV1Contract,
  RunnerJobResultV1Contract,
  type Lease,
  type RunnerJobFailureV1,
} from '../control-store/types.js';
import {
  persistJsonArtifact,
  verifyArtifactReferences,
} from './artifacts.js';
import type { AgentOpsRunnerAdapter } from './adapter.js';
import { runnerFailure, RunnerExecutionError } from './errors.js';
import { RunnerLeaseFence } from './guard.js';
import {
  RunnerWorkspaceManager,
  type PreparedRunnerWorkspace,
} from './workspace.js';

export interface RunnerServiceConfig {
  workerId: string;
  workspaceRoot: string;
  provider: 'codex' | 'claude';
  operatingMode?: 'MONITOR_ONLY' | 'ACTIVE' | 'DRAINING';
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  /** Kept only in workerData; never restored to provider/grader process env. */
  heartbeatDatabaseUrl?: string;
  reconciliationIntervalMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  attemptTimeoutMs: number;
}

export interface RunnerServiceDependencies {
  store: PostgresControlStore;
  workspace: RunnerWorkspaceManager;
  adapter: AgentOpsRunnerAdapter;
  log?: (message: string) => void;
}

class LeaseHeartbeat {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private worker: Worker | null = null;
  private deadlineTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: PostgresControlStore,
    private readonly lease: Lease,
    private readonly fence: RunnerLeaseFence,
    private readonly durationMs: number,
    private readonly intervalMs: number,
    private readonly log: (message: string) => void,
    private readonly databaseUrl?: string,
    private readonly attemptTimeoutMs = 4 * 60 * 60_000,
  ) {}

  start(): void {
    if (this.databaseUrl) {
      this.worker = new Worker(new URL('./heartbeat-worker.js', import.meta.url), {
        workerData: {
          connectionString: this.databaseUrl,
          token: this.lease.token,
          workerId: this.lease.workerId,
          durationMs: this.durationMs,
          intervalMs: this.intervalMs,
          attemptTimeoutMs: this.attemptTimeoutMs,
        },
      });
      this.worker.on('message', (message: unknown) => {
        if (
          message
          && typeof message === 'object'
          && (message as { type?: unknown }).type === 'lost'
        ) {
          const detail = String((message as { message?: unknown }).message ?? 'unknown');
          this.fence.markLost(`heartbeat worker failed: ${detail}`);
          this.log(`runner heartbeat lost lease ${this.lease.id}: ${detail}`);
        }
      });
      this.worker.on('error', (error) => {
        this.fence.markLost(`heartbeat worker crashed: ${error.message}`);
        this.log(
          `runner heartbeat worker crashed for lease ${this.lease.id}: ${error.message}`,
        );
      });
      this.worker.on('exit', (code) => {
        if (this.worker && code !== 0) {
          const detail = `heartbeat worker exited unexpectedly with code ${code}`;
          this.fence.markLost(detail);
          this.log(`runner ${detail} for lease ${this.lease.id}`);
        }
      });
      return;
    }
    this.deadlineTimer = setTimeout(() => {
      this.fence.markLost('overall attempt deadline exceeded');
      this.log(`runner attempt deadline exceeded for lease ${this.lease.id}`);
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    }, this.attemptTimeoutMs);
    this.deadlineTimer.unref();
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = this.store.heartbeatLease(this.lease.token, this.durationMs)
        .then(() => undefined)
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.fence.markLost(`heartbeat failed: ${message}`);
          this.log(`runner heartbeat lost lease ${this.lease.id}: ${message}`);
        })
        .finally(() => {
          this.inFlight = null;
        });
    }, this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
    await this.inFlight;
    if (this.worker) {
      const worker = this.worker;
      this.worker = null;
      const exited = new Promise<void>((resolve) => {
        worker.once('exit', () => resolve());
      });
      worker.postMessage({ type: 'stop' });
      const timeout = new Promise<void>((resolve) => {
        setTimeout(resolve, Math.max(1_000, this.intervalMs * 2)).unref();
      });
      await Promise.race([exited, timeout]);
      await worker.terminate();
    }
  }
}

export class IsolatedRunnerService {
  private stopping = false;
  private active: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  private readonly store: PostgresControlStore;
  private readonly workspace: RunnerWorkspaceManager;
  private readonly adapter: AgentOpsRunnerAdapter;
  private readonly log: (message: string) => void;

  constructor(
    readonly config: RunnerServiceConfig,
    dependencies: RunnerServiceDependencies,
  ) {
    this.store = dependencies.store;
    this.workspace = dependencies.workspace;
    this.adapter = dependencies.adapter;
    this.log = dependencies.log ?? (() => {});
  }

  requestDrain(): void {
    this.stopping = true;
    this.wake?.();
  }

  private retryDelay(attemptNumber: number): number {
    const exponent = Math.max(0, attemptNumber - 1);
    return Math.min(
      60 * 60_000,
      this.config.retryBaseMs * (2 ** exponent),
    );
  }

  private async recordFailure(
    lease: Lease,
    failure: RunnerJobFailureV1,
  ): Promise<void> {
    try {
      const status = await this.store.failOrRetryLease({
        token: lease.token,
        workerId: this.config.workerId,
        failure,
        retryDelayMs: this.retryDelay(lease.attemptNumber),
        maxAttempts: this.config.maxAttempts,
      });
      this.log(
        `runner ${lease.job.id} attempt ${lease.attemptNumber} ${status}: `
        + `${failure.code}: ${failure.message}`,
      );
    } catch (error) {
      // A concurrent expiry/reclaimer is authoritative. Never revive or finish
      // work after ownership is gone.
      this.log(
        `runner could not record failure for lost lease ${lease.id}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async processLease(lease: Lease): Promise<void> {
    const fence = new RunnerLeaseFence(
      this.store,
      lease,
      this.config.workerId,
      Math.min(5_000, Math.floor(this.config.leaseDurationMs / 4)),
    );
    const heartbeat = new LeaseHeartbeat(
      this.store,
      lease,
      fence,
      this.config.leaseDurationMs,
      this.config.heartbeatIntervalMs,
      this.log,
      this.config.heartbeatDatabaseUrl,
      this.config.attemptTimeoutMs,
    );
    let prepared: PreparedRunnerWorkspace | null = null;
    heartbeat.start();
    try {
      const envelopeParsed = JobEnvelopeContract.safeParse(lease.job);
      if (!envelopeParsed.success) {
        throw new RunnerExecutionError(
          'unknown_job_contract',
          `runner refuses malformed/unknown envelope: ${envelopeParsed.error.message}`,
          false,
        );
      }
      const envelope = envelopeParsed.data;
      if (envelope.jobType !== 'agentops.runner') {
        throw new RunnerExecutionError(
          'unknown_job_contract',
          `runner refuses jobType ${envelope.jobType}`,
          false,
        );
      }
      const payloadParsed = RunnerJobPayloadV1Contract.safeParse(envelope.payload);
      if (!payloadParsed.success) {
        throw new RunnerExecutionError(
          'unknown_job_contract',
          `runner refuses malformed/unknown payload: ${payloadParsed.error.message}`,
          false,
        );
      }
      const payload = payloadParsed.data;
      const repository = `${payload.repository.owner}/${payload.repository.name}`;
      const registration = await this.store.getRegistration(envelope.registrationId);
      if (
        !registration
        || registration.repository !== repository
        || registration.version !== envelope.registrationVersion
      ) {
        throw new RunnerExecutionError(
          'registration_stale',
          `job repository/version does not match Registration ${envelope.registrationId}`,
          false,
          'claim',
        );
      }
      verifyArtifactReferences(
        this.config.workspaceRoot,
        envelope.registrationId,
        payload.artifacts,
      );

      // Checkout reaches GitHub and therefore receives the same DB-backed
      // authorization used for provider execution.
      await fence.arm('provider');
      prepared = this.workspace.prepare(lease, payload);
      const adapterResult = await this.adapter.execute({
        lease,
        payload,
        workspace: prepared,
        fence,
        provider: this.config.provider,
        log: this.log,
      });
      fence.assertLive('release');
      const evidence = await persistJsonArtifact({
        store: this.store,
        lease,
        workerId: this.config.workerId,
        workspace: prepared,
        kind: 'runner-result',
        name: 'runner-result.json',
        value: {
          schemaVersion: 1,
          jobId: lease.job.id,
          attemptNumber: lease.attemptNumber,
          repository,
          headSha: adapterResult.headSha,
          pullRequestNumber: adapterResult.pullRequestNumber,
          developmentTurn: adapterResult.developmentTurn,
          completedAt: new Date().toISOString(),
        },
      });
      const result = RunnerJobResultV1Contract.parse({
        schemaVersion: 1,
        status: 'succeeded',
        jobId: lease.job.id,
        attemptNumber: lease.attemptNumber,
        repository,
        headSha: adapterResult.headSha,
        pullRequestNumber: adapterResult.pullRequestNumber,
        artifacts: [evidence],
        completedAt: new Date().toISOString(),
      });
      await this.store.finishLease(lease.token, { status: 'succeeded', result });
      this.log(
        `runner completed ${lease.job.id} attempt ${lease.attemptNumber} `
        + `at ${result.headSha ?? 'no-head'}`,
      );
    } catch (error) {
      await this.recordFailure(lease, runnerFailure(error));
    } finally {
      await heartbeat.stop();
      if (prepared) this.workspace.cleanup(prepared);
    }
  }

  async runOnce(): Promise<boolean> {
    if (this.stopping) return false;
    if (this.config.operatingMode !== 'ACTIVE') return false;
    await this.store.reclaimExpiredLeases(this.config.maxAttempts, {
      jobType: 'agentops.runner',
      retryBaseMs: this.config.retryBaseMs,
    });
    const lease = await this.store.acquireLease({
      workerId: this.config.workerId,
      durationMs: this.config.leaseDurationMs,
      jobType: 'agentops.runner',
    });
    if (!lease) return false;
    this.active = this.processLease(lease);
    try {
      await this.active;
    } finally {
      this.active = null;
    }
    return true;
  }

  private waitForWake(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, this.config.reconciliationIntervalMs);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  async run(): Promise<void> {
    const stopListening = await this.store.listen('agentops_job_wake', () => {
      this.wake?.();
    });
    try {
      while (!this.stopping) {
        while (!this.stopping && await this.runOnce()) {
          // Drain all currently claimable work before sleeping.
        }
        if (!this.stopping) await this.waitForWake();
      }
      await this.active;
    } finally {
      await stopListening();
    }
  }
}
