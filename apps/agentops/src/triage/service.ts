import type { PostgresControlStore } from '../control-store/store.js';
import {
  JobEnvelopeContract,
  ReleaseSourceIssueSnapshotContract,
  TriageJobPayloadV1Contract,
  TriageJobResultV1Contract,
  releaseSourceIssueSnapshotDigest,
  type Lease,
  type RunnerJobFailureV1,
  type TriageDecisionV1,
  type TriageJobPayloadV1,
  type TriageJobResultV1,
} from '../control-store/types.js';
import { RunnerExecutionError } from '../runner/errors.js';
import {
  authoritativeTriageComments,
  hasTriageMarker,
  triageMarker,
  triageSourceDigest,
  TriageSourceTooLargeError,
  type TriageGitHub,
  type TriageSnapshot,
} from './github.js';

import {
  labelForDecision,
  type TriagePolicy,
} from './policy.js';
import type { TriageProvider } from './provider.js';
import {
  linkedParentIssueNumber,
  type DevelopmentProgressUpdate,
} from '../domain/development-progress.js';

// GitHub's REST Issue and Issue-event timestamps have only second precision,
// and the Issue updated_at produced by a label mutation can become visible one
// second after that label event. Keep this tolerance to exactly one timestamp
// tick, and apply it only to the Issue row. Comment timestamps remain strict
// because a new/edited comment is independently versioned authority.
const READY_LABEL_ISSUE_TIMESTAMP_TOLERANCE_MS = 1_000;

export function boundedProgressBlocker(parts: readonly string[]): string {
  const joined = parts.filter((part) => part.trim() !== '').join('; ');
  const characters = Array.from(joined);
  return characters.length <= 1_000
    ? joined
    : `${characters.slice(0, 999).join('')}…`;
}

function releaseSourceIssueCore(
  repository: string,
  snapshot: TriageSnapshot,
  capturedAt: string,
) {
  const comments = authoritativeTriageComments(snapshot).map((comment) => ({
    id: comment.id,
    body: comment.body,
    updatedAt: comment.updatedAt,
    url: comment.url,
    author: comment.author,
  }));
  const sourceUpdatedAt = comments.reduce(
    (latest, comment) => Date.parse(comment.updatedAt) > Date.parse(latest)
      ? comment.updatedAt
      : latest,
    snapshot.issue.updatedAt,
  );
  return {
    repository,
    number: snapshot.issue.number,
    title: snapshot.issue.title,
    body: snapshot.issue.body,
    url: snapshot.issue.url,
    labels: [...snapshot.issue.labels].sort(),
    comments,
    state: snapshot.issue.state,
    sourceUpdatedAt,
    capturedAt,
  };
}

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
  recordDevelopmentProgress?: PostgresControlStore['recordDevelopmentProgress'];
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

function assertPromotionEligibility(
  snapshot: TriageSnapshot,
  payload: TriageJobPayloadV1,
  claimedLabel: string,
): void {
  if (
    snapshot.issue.number !== payload.issue.number
    || Date.parse(snapshot.issue.updatedAt) < Date.parse(payload.issue.observedUpdatedAt)
    || snapshot.issue.state !== 'open'
    || snapshot.issue.isPullRequest
    || snapshot.issue.labels.includes(claimedLabel)
  ) {
    throw new RunnerExecutionError(
      'provider_failure',
      'GitHub Issue is no longer eligible for ready promotion',
      false,
    );
  }
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
    reportProgress: (event: DevelopmentProgressUpdate) => Promise<void>,
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
    // GitHub's Issue updatedAt is the only title/body version boundary exposed
    // by the snapshot API. Its label-update propagation can lag the matching
    // event by one second, so tolerate exactly that one timestamp tick for the
    // Issue row. Comments have their own timestamp and remain strictly bounded.
    // A later edit must be followed by a new remove/add ready action.
    const sourceIssueCore = releaseSourceIssueCore(
      repository,
      snapshot,
      new Date().toISOString(),
    );
    const readyAt = Date.parse(latestReadyEvent.createdAt);
    const issueChangedAfterReady = Date.parse(snapshot.issue.updatedAt)
      > readyAt + READY_LABEL_ISSUE_TIMESTAMP_TOLERANCE_MS;
    const commentChangedAfterReady = snapshot.comments.some(
      (comment) => Date.parse(comment.updatedAt) > readyAt,
    );
    if (issueChangedAfterReady || commentChangedAfterReady) {
      throw new RunnerExecutionError(
        'provider_failure',
        'Issue content changed after the latest ready event; human must reapply the ready label',
        false,
      );
    }
    assertPromotionEligibility(
      snapshot,
      payload,
      this.dependencies.policy.claimedLabel,
    );
    const result = triageResult(lease, payload, repository, {
      outcome: 'promoted',
      sourceDigest: null,
      decision: null,
      commentUrl: null,
      appliedLabels: [],
      promotedJobId: null,
    });
    const sourceIssue = ReleaseSourceIssueSnapshotContract.parse({
      ...sourceIssueCore,
      digest: releaseSourceIssueSnapshotDigest(sourceIssueCore),
    });
    const parentIssueNumber = linkedParentIssueNumber(
      sourceIssue.body,
      sourceIssue.number,
    );
    // Announced as in-flight, never as done: the freeze is only a fact once the
    // database has bound the snapshot to a promoted job below. Reporting
    // `succeeded` first would leave a durable event asserting a freeze that a
    // failed promotion never performed.
    await reportProgress({
      eventKey: 'triage:ready-authority-frozen',
      phase: 'intake',
      step: 'ready authority frozen',
      state: 'running',
      summary: `Freezing immutable requirements for ${repository}#${payload.issue.number}`,
      nextGate: 'durable release authority',
      parentIssueNumber,
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
        sourceIssue,
        ...(triageAuthority ? { triage: triageAuthority } : {}),
      },
    });
    // No completion event is published here: promotion closes this very lease,
    // and `record_development_progress` accepts writes only from a live one.
    // The runner's own `intake:runner-start` is the next durable transition.
    this.log(
      `triage promoted ${repository}#${payload.issue.number} `
      + `to development job ${promotedJobId}`,
    );
  }

  /**
   * Read the Issue, converting an over-limit Source Issue into an operator-facing
   * blocker before it surfaces as an opaque job failure. The limit is a property
   * of the Issue's own text, so it can only be resolved by a human shortening it.
   */
  private async readTriageSnapshot(
    repository: string,
    issueNumber: number,
    reportProgress: (event: DevelopmentProgressUpdate) => Promise<void>,
  ): Promise<TriageSnapshot> {
    try {
      return await this.dependencies.github.snapshot(repository, issueNumber);
    } catch (error) {
      if (!(error instanceof TriageSourceTooLargeError)) throw error;
      await reportProgress({
        eventKey: 'triage:source-too-large',
        phase: 'human-review',
        step: 'Source Issue exceeds the frozen requirements limit',
        state: 'blocked',
        summary: `${repository}#${issueNumber} cannot be frozen verbatim`,
        blocker: boundedProgressBlocker([
          error.detail,
          'Requirements are never truncated, so the Issue text itself must be shortened.',
        ]),
        nextGate: 'human shortens the Issue or moves the detail into a linked document',
      });
      throw new RunnerExecutionError('provider_failure', error.message, false);
    }
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
    const reportProgress = async (event: DevelopmentProgressUpdate): Promise<void> => {
      try {
        await this.dependencies.store.recordDevelopmentProgress?.({
          token: lease.token,
          workerId: this.config.workerId,
          event,
        });
      } catch (error) {
        this.log(
          `⚠ durable triage progress failed for ${event.eventKey}: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
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
      await reportProgress({
        eventKey: 'triage:start',
        phase: 'intake',
        step: 'triage Issue requirements',
        state: 'running',
        summary: `Evaluating ${repository}#${payload.issue.number}`,
        nextGate: 'triage decision or human ready authority',
      });
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
      const snapshot = await this.readTriageSnapshot(
        repository,
        payload.issue.number,
        reportProgress,
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
      const triageParentIssueNumber = linkedParentIssueNumber(
        snapshot.issue.body,
        snapshot.issue.number,
      );
      // Refresh the idempotent start event after the first authoritative
      // snapshot so the parent Epic can see even pre-ready triage activity.
      await reportProgress({
        eventKey: 'triage:start',
        phase: 'intake',
        step: 'triage Issue requirements',
        state: 'running',
        summary: `Evaluating ${repository}#${payload.issue.number}`,
        nextGate: 'triage decision or human ready authority',
        parentIssueNumber: triageParentIssueNumber,
      });
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
        const current = await this.readTriageSnapshot(
          repository,
          payload.issue.number,
          reportProgress,
        );
        assertPromotionEligibility(
          current,
          payload,
          this.dependencies.policy.claimedLabel,
        );
        const observedRequirements = releaseSourceIssueSnapshotDigest(
          releaseSourceIssueCore(repository, snapshot, snapshot.issue.updatedAt),
        );
        const currentRequirements = releaseSourceIssueSnapshotDigest(
          releaseSourceIssueCore(repository, current, current.issue.updatedAt),
        );
        if (currentRequirements !== observedRequirements) {
          throw new RunnerExecutionError(
            'provider_failure',
            'GitHub Issue requirements changed while ready promotion was being verified',
            true,
          );
        }
        await this.promote(
          lease,
          payload,
          repository,
          current,
          heartbeat,
          reportProgress,
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
      const current = await this.readTriageSnapshot(
        repository,
        payload.issue.number,
        reportProgress,
      );
      if (current.issue.labels.includes(this.dependencies.policy.readyLabel)) {
        await this.promote(
          lease,
          payload,
          repository,
          current,
          heartbeat,
          reportProgress,
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

      await reportProgress(decision.readiness === 'needs_info'
        ? {
            eventKey: 'triage:needs-info',
            phase: 'human-review',
            step: 'triage needs information',
            state: 'blocked',
            summary: decision.summary,
            blocker: boundedProgressBlocker(
              decision.missingInformation.length > 0
                ? decision.missingInformation
                : decision.rationale,
            ),
            nextGate: 'human updates the Issue; apply ready after the missing information is supplied',
            parentIssueNumber: triageParentIssueNumber,
          }
        : decision.readiness === 'blocked'
          ? {
              eventKey: 'triage:blocked',
              phase: 'human-review',
              step: 'triage blocked',
              state: 'blocked',
              summary: decision.summary,
              blocker: boundedProgressBlocker(decision.rationale),
              nextGate: 'human resolves the dependency or scope blocker',
              parentIssueNumber: triageParentIssueNumber,
            }
          : {
              eventKey: 'triage:ready-candidate',
              phase: 'intake',
              step: 'triage ready candidate',
              state: 'waiting',
              summary: decision.summary,
              nextGate: 'human applies the ready label',
              parentIssueNumber: triageParentIssueNumber,
            });

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
