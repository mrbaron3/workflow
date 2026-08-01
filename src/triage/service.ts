import type { PostgresControlStore } from '../control-store/store.js';
import {
  JobEnvelopeContract,
  TriageJobPayloadV1Contract,
  TriageJobResultV1Contract,
  type Lease,
  type RunnerJobFailureV1,
  type TriageDecisionV1,
  type TriageJobPayloadV1,
  type TriageJobResultV1,
} from '../control-store/types.js';
import { RunnerExecutionError } from '../runner/errors.js';
import {
  hasTriageMarker,
  triageMarker,
  triageSourceDigest,
  type TriageGitHub,
  type TriageSnapshot,
} from './github.js';
import {
  labelForDecision,
  type TriagePolicy,
} from './policy.js';
import type { TriageProvider } from './provider.js';

export interface TriageServiceConfig {
  workerId: string;
  operatingMode: 'MONITOR_ONLY' | 'ACTIVE' | 'DRAINING';
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  reconciliationIntervalMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  attemptTimeoutMs: number;
  providerProvenance?: Omit<
    NonNullable<TriageJobResultV1['providerProvenance']>,
    'attemptId'
  > | null;
}

interface TriageStore {
  reclaimExpiredLeases(
    maxAttempts: number,
    options: { jobType: string; retryBaseMs: number },
  ): ReturnType<PostgresControlStore['reclaimExpiredLeases']>;
  acquireLease(
    input: Parameters<PostgresControlStore['acquireLease']>[0],
  ): ReturnType<PostgresControlStore['acquireLease']>;
  heartbeatLease(
    token: string,
    durationMs: number,
  ): ReturnType<PostgresControlStore['heartbeatLease']>;
  getRegistration(
    id: string,
  ): ReturnType<PostgresControlStore['getRegistration']>;
  finishTriageLease(
    input: Parameters<PostgresControlStore['finishTriageLease']>[0],
  ): ReturnType<PostgresControlStore['finishTriageLease']>;
  promoteTriageLease(
    input: Parameters<PostgresControlStore['promoteTriageLease']>[0],
  ): ReturnType<PostgresControlStore['promoteTriageLease']>;
  failOrRetryLease(
    input: Parameters<PostgresControlStore['failOrRetryLease']>[0],
  ): ReturnType<PostgresControlStore['failOrRetryLease']>;
  listen: PostgresControlStore['listen'];
}

export interface TriageServiceDependencies {
  store: TriageStore;
  github: TriageGitHub;
  provider: TriageProvider;
  policy: TriagePolicy;
  log?: (message: string) => void;
}

function safeText(value: string): string {
  return value.replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function issueRef(repository: string, issueNumber: number): string {
  return `${repository}#${issueNumber}`;
}

export function formatTriageComment(
  repository: string,
  issueNumber: number,
  sourceDigest: string,
  decision: TriageDecisionV1,
  policy: TriagePolicy,
): string {
  const dependencies = decision.dependencies.length > 0
    ? decision.dependencies.map((dependency) =>
        `- \`${issueRef(dependency.repository, dependency.issueNumber)}\` — `
        + dependency.relationship).join('\n')
    : '- なし';
  const duplicates = decision.duplicateCandidates.length > 0
    ? decision.duplicateCandidates.map((candidate) =>
        `- \`${issueRef(candidate.repository, candidate.issueNumber)}\` — `
        + safeText(candidate.reason)).join('\n')
    : '- なし';
  const missing = decision.missingInformation.length > 0
    ? decision.missingInformation.map((item) => `- ${safeText(item)}`).join('\n')
    : '- なし';
  return [
    triageMarker(sourceDigest, decision.readiness),
    '### AgentOps triage',
    '',
    `- 判定: \`${decision.readiness}\``,
    `- 種別: \`${decision.type}\``,
    `- North Star: \`${decision.northStarAlignment}\``,
    `- 優先度: \`${decision.priority}\``,
    `- 管理ラベル: \`${labelForDecision(policy, decision)}\``,
    '',
    safeText(decision.summary),
    '',
    '根拠:',
    ...decision.rationale.map((reason) => `- ${safeText(reason)}`),
    '',
    '依存関係:',
    dependencies,
    '',
    '重複候補:',
    duplicates,
    '',
    '不足情報:',
    missing,
    '',
    `人間が実装開始を承認するときだけ \`${policy.readyLabel}\` を付けてください。`,
    `この処理はIssueをclaimせず、branch・PR・mergeを変更しません。`,
    '',
    `対象: \`${issueRef(repository, issueNumber)}\``,
  ].join('\n');
}

function failure(
  code: RunnerJobFailureV1['code'],
  message: string,
  retryable: boolean,
): RunnerJobFailureV1 {
  return {
    schemaVersion: 1,
    status: 'failed',
    code,
    message: message.trim().slice(0, 2_000) || 'triage failed',
    retryable,
    boundary: null,
    observedAt: new Date().toISOString(),
  };
}

class TriageHeartbeat {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private lost: Error | null = null;

  constructor(
    private readonly store: TriageStore,
    private readonly lease: Lease,
    private readonly durationMs: number,
    private readonly intervalMs: number,
    private readonly log: (message: string) => void,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      if (this.inFlight || this.lost) return;
      this.inFlight = this.store
        .heartbeatLease(this.lease.token, this.durationMs)
        .then(() => undefined)
        .catch(() => {
          this.lost = new Error('triage lease heartbeat was lost');
          this.log(`triage heartbeat lost lease ${this.lease.id}`);
        })
        .finally(() => {
          this.inFlight = null;
        });
    }, this.intervalMs);
    this.timer.unref();
  }

  async assertLive(): Promise<void> {
    if (this.lost) throw this.lost;
    await this.store.heartbeatLease(this.lease.token, this.durationMs);
    if (this.lost) throw this.lost;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }
}

function triageResult(
  lease: Lease,
  payload: TriageJobPayloadV1,
  repository: string,
  values: Pick<
    TriageJobResultV1,
    | 'outcome'
    | 'sourceDigest'
    | 'decision'
    | 'commentUrl'
    | 'appliedLabels'
    | 'promotedJobId'
  > & Partial<Pick<TriageJobResultV1, 'providerProvenance'>>,
): TriageJobResultV1 {
  return TriageJobResultV1Contract.parse({
    schemaVersion: 1,
    status: 'succeeded',
    jobId: lease.job.id,
    attemptNumber: lease.attemptNumber,
    repository,
    issueNumber: payload.issue.number,
    ...values,
    providerProvenance: values.providerProvenance ?? null,
    completedAt: new Date().toISOString(),
  });
}

export class TriageRunnerService {
  private stopping = false;
  private active: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private readonly log: (message: string) => void;

  constructor(
    readonly config: TriageServiceConfig,
    private readonly dependencies: TriageServiceDependencies,
  ) {
    this.log = dependencies.log ?? (() => {});
  }

  requestDrain(): void {
    this.stopping = true;
    this.wake?.();
  }

  private retryDelay(attemptNumber: number): number {
    return Math.min(
      60 * 60_000,
      this.config.retryBaseMs * (2 ** Math.max(0, attemptNumber - 1)),
    );
  }

  private async recordFailure(
    lease: Lease,
    result: RunnerJobFailureV1,
  ): Promise<void> {
    try {
      const status = await this.dependencies.store.failOrRetryLease({
        token: lease.token,
        workerId: this.config.workerId,
        failure: result,
        retryDelayMs: this.retryDelay(lease.attemptNumber),
        maxAttempts: this.config.maxAttempts,
      });
      this.log(
        `triage ${lease.job.id} attempt ${lease.attemptNumber} ${status}: `
        + `${result.code}: ${result.message}`,
      );
    } catch {
      this.log(
        `triage could not record failure for lost lease ${lease.id}; `
        + 'lease recovery remains authoritative',
      );
    }
  }

  private async promote(
    lease: Lease,
    payload: TriageJobPayloadV1,
    repository: string,
    snapshot: TriageSnapshot,
    heartbeat: TriageHeartbeat,
    triageAuthority?: {
      sourceDigest: string;
      decision: TriageDecisionV1;
      completedAt: string;
      providerProvenance: NonNullable<TriageJobResultV1['providerProvenance']>;
    },
  ): Promise<void> {
    if (!snapshot.issue.labels.includes(this.dependencies.policy.readyLabel)) {
      throw new RunnerExecutionError(
        'provider_failure',
        'ready label disappeared before triage promotion',
        true,
      );
    }
    await heartbeat.assertLive();
    const latestReadyEvent = [...snapshot.labelEvents]
      .filter((event) => event.label === this.dependencies.policy.readyLabel)
      .sort((left, right) => (
        left.createdAt.localeCompare(right.createdAt) || left.id - right.id
      ))
      .at(-1);
    if (!latestReadyEvent || latestReadyEvent.action !== 'labeled') {
      throw new RunnerExecutionError(
        'provider_failure',
        'ready authority cannot be proven from the GitHub Issue event ledger',
        false,
      );
    }
    const result = triageResult(lease, payload, repository, {
      outcome: 'promoted',
      sourceDigest: null,
      decision: null,
      commentUrl: null,
      appliedLabels: [],
      promotedJobId: null,
    });
    const promotedJobId = await this.dependencies.store.promoteTriageLease({
      token: lease.token,
      workerId: this.config.workerId,
      result,
      readyLabel: this.dependencies.policy.readyLabel,
      claimedLabel: this.dependencies.policy.claimedLabel,
      authority: {
        actor: latestReadyEvent.actor,
        readyAt: latestReadyEvent.createdAt,
        ...(triageAuthority ? { triage: triageAuthority } : {}),
      },
    });
    this.log(
      `triage promoted ${repository}#${payload.issue.number} `
      + `to development job ${promotedJobId}`,
    );
  }

  private async processLease(lease: Lease): Promise<void> {
    const heartbeat = new TriageHeartbeat(
      this.dependencies.store,
      lease,
      this.config.leaseDurationMs,
      this.config.heartbeatIntervalMs,
      this.log,
    );
    heartbeat.start();
    try {
      const envelope = JobEnvelopeContract.parse(lease.job);
      if (envelope.jobType !== 'agentops.triage') {
        throw new RunnerExecutionError(
          'unknown_job_contract',
          `triage runner refuses jobType ${envelope.jobType}`,
          false,
        );
      }
      const payload = TriageJobPayloadV1Contract.parse(envelope.payload);
      const repository =
        `${payload.repository.owner}/${payload.repository.name}`;
      const registration = await this.dependencies.store.getRegistration(
        envelope.registrationId,
      );
      if (
        !registration
        || registration.repository !== repository
        || registration.version !== envelope.registrationVersion
        || !registration.enabled
        || !registration.executionEnabled
      ) {
        throw new RunnerExecutionError(
          'registration_stale',
          `triage job does not match live Registration ${envelope.registrationId}`,
          false,
        );
      }
      const snapshot = await this.dependencies.github.snapshot(
        repository,
        payload.issue.number,
      );
      if (
        snapshot.issue.number !== payload.issue.number
        || Date.parse(snapshot.issue.updatedAt)
          < Date.parse(payload.issue.observedUpdatedAt)
      ) {
        throw new RunnerExecutionError(
          'provider_failure',
          'GitHub Issue observation is older than the queued monitor event',
          true,
        );
      }
      if (
        snapshot.issue.state !== 'open'
        || snapshot.issue.isPullRequest
        || snapshot.issue.labels.includes(this.dependencies.policy.claimedLabel)
      ) {
        await heartbeat.assertLive();
        await this.dependencies.store.finishTriageLease({
          token: lease.token,
          workerId: this.config.workerId,
          result: triageResult(lease, payload, repository, {
            outcome: 'skipped',
            sourceDigest: null,
            decision: null,
            commentUrl: null,
            appliedLabels: [],
            promotedJobId: null,
          }),
        });
        return;
      }
      if (snapshot.issue.labels.includes(this.dependencies.policy.readyLabel)) {
        const current = await this.dependencies.github.snapshot(
          repository,
          payload.issue.number,
        );
        await this.promote(
          lease,
          payload,
          repository,
          current,
          heartbeat,
        );
        return;
      }

      const sourceDigest = triageSourceDigest(
        repository,
        snapshot,
        this.dependencies.policy,
      );
      const existing = hasTriageMarker(snapshot, sourceDigest);
      if (existing) {
        await heartbeat.assertLive();
        await this.dependencies.store.finishTriageLease({
          token: lease.token,
          workerId: this.config.workerId,
          result: triageResult(lease, payload, repository, {
            outcome: 'unchanged',
            sourceDigest,
            decision: null,
            commentUrl: existing.url,
            appliedLabels: [],
            promotedJobId: null,
          }),
        });
        return;
      }

      const context = await this.dependencies.github.repositoryContext(
        repository,
        payload.issue.number,
        this.dependencies.policy.contextPaths,
      );
      if (registration.configuration.releaseEvidence
        && !this.config.providerProvenance) {
        throw new RunnerExecutionError(
          'startup_isolation_failure',
          'release receipt runtime provenance is not configured for AI triage',
          false,
        );
      }
      const decision = await this.dependencies.provider.analyze({
        repository,
        snapshot,
        context,
      });
      const triageCompletedAt = new Date().toISOString();
      const providerProvenance = !this.config.providerProvenance
        ? null
        : { ...this.config.providerProvenance, attemptId: lease.attemptId };
      const current = await this.dependencies.github.snapshot(
        repository,
        payload.issue.number,
      );
      if (current.issue.labels.includes(this.dependencies.policy.readyLabel)) {
        await this.promote(
          lease,
          payload,
          repository,
          current,
          heartbeat,
          providerProvenance === null
            ? undefined
            : {
                sourceDigest,
                decision,
                completedAt: triageCompletedAt,
                providerProvenance,
              },
        );
        return;
      }
      if (
        triageSourceDigest(repository, current, this.dependencies.policy)
        !== sourceDigest
      ) {
        throw new RunnerExecutionError(
          'provider_failure',
          'Issue changed while triage analysis was in progress',
          true,
        );
      }

      await heartbeat.assertLive();
      await this.dependencies.github.ensureManagedLabels(
        repository,
        this.dependencies.policy,
      );
      const desiredLabel = labelForDecision(
        this.dependencies.policy,
        decision,
      );
      const appliedLabels = await this.dependencies.github.applyManagedLabel(
        repository,
        payload.issue.number,
        desiredLabel,
        this.dependencies.policy,
      );
      const commentUrl = await this.dependencies.github.createComment(
        repository,
        payload.issue.number,
        formatTriageComment(
          repository,
          payload.issue.number,
          sourceDigest,
          decision,
          this.dependencies.policy,
        ),
      );
      await heartbeat.assertLive();
      await this.dependencies.store.finishTriageLease({
        token: lease.token,
        workerId: this.config.workerId,
        result: triageResult(lease, payload, repository, {
          outcome: 'triaged',
          sourceDigest,
          decision,
          commentUrl,
          appliedLabels,
          promotedJobId: null,
          providerProvenance,
        }),
      });
      this.log(
        `triage classified ${repository}#${payload.issue.number} `
        + `as ${decision.readiness}`,
      );
    } catch (error) {
      const result = error instanceof RunnerExecutionError
        ? error.toFailure()
        : error instanceof Error
          && /contract|schema|jobType|payload/i.test(error.message)
          ? failure('unknown_job_contract', 'triage job contract is invalid', false)
          : failure(
              'provider_failure',
              error instanceof Error ? error.message : 'triage failed',
              true,
            );
      await this.recordFailure(lease, result);
    } finally {
      await heartbeat.stop();
    }
  }

  async runOnce(): Promise<boolean> {
    if (this.stopping || this.config.operatingMode !== 'ACTIVE') return false;
    await this.dependencies.store.reclaimExpiredLeases(
      this.config.maxAttempts,
      {
        jobType: 'agentops.triage',
        retryBaseMs: this.config.retryBaseMs,
      },
    );
    const lease = await this.dependencies.store.acquireLease({
      workerId: this.config.workerId,
      durationMs: this.config.leaseDurationMs,
      jobType: 'agentops.triage',
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
    const stopListening = await this.dependencies.store.listen(
      'agentops_job_wake',
      () => this.wake?.(),
    );
    try {
      while (!this.stopping) {
        while (!this.stopping && await this.runOnce()) {
          // Drain every currently claimable triage job before sleeping.
        }
        if (!this.stopping) await this.waitForWake();
      }
      await this.active;
    } finally {
      await stopListening();
    }
  }
}
