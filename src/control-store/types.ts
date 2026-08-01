import { z } from 'zod';

import {
  ProviderModelSelectionContract,
  ReleaseRuntimeConsumerContract,
  ReleaseRuntimeEnvironmentContract,
  ReleasePolicyContract,
  type DurableReleaseReceipt,
  type ReleasePolicy,
} from '../evidence/release-receipt.js';

export const CONTROL_SCHEMA_VERSION = 10;

const RepositoryOwner = z.string()
  .min(1)
  .max(39)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/);
const RepositoryName = z.string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_.-]+$/)
  .refine((value) => value !== '.' && value !== '..');
export const CanonicalRepository = z.string().superRefine((value, context) => {
  const [owner, name, ...rest] = value.split('/');
  if (
    rest.length !== 0
    || !RepositoryOwner.safeParse(owner).success
    || !RepositoryName.safeParse(name).success
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'repository must be canonical owner/name',
    });
  }
});

export const MonitorBrokerKind = z.enum(['issue', 'pull_request']);
export type MonitorBrokerKind = z.infer<typeof MonitorBrokerKind>;

export const MonitorBrokerCursor = z.object({
  updatedAfter: z.string().datetime({ offset: true }).or(z.literal('')),
}).strict();
export type MonitorBrokerCursor = z.infer<typeof MonitorBrokerCursor>;

export interface MonitorBrokerRequest {
  id: string;
  registrationId: string;
  registrationVersion: number;
  repository: string;
  monitorKind: MonitorBrokerKind;
  cursor: MonitorBrokerCursor;
  leaseToken: string;
}

export const MonitorBrokerResponse = z.object({
  items: z.array(z.object({
    repository: CanonicalRepository,
    kind: MonitorBrokerKind,
    number: z.number().int().positive().max(2_147_483_647),
    updatedAt: z.string().datetime({ offset: true }),
  }).strict()).max(1_000),
  nextCursor: MonitorBrokerCursor,
  observedAt: z.string().datetime({ offset: true }),
}).strict();
export type MonitorBrokerResponse = z.infer<typeof MonitorBrokerResponse>;

export const RepositoryRegistrationInput = z.object({
  repository: z.string().trim().toLowerCase()
    .pipe(CanonicalRepository),
  enabled: z.boolean().default(true),
  issueMonitorEnabled: z.boolean().default(true),
  prMonitorEnabled: z.boolean().default(true),
  executionEnabled: z.boolean().default(true),
  configuration: z.object({
    releaseEvidence: ReleasePolicyContract.optional(),
  }).strict().default({}),
});
export type RepositoryRegistrationInput = z.infer<typeof RepositoryRegistrationInput>;
export const RepositoryRegistrationPatch = RepositoryRegistrationInput
  .omit({ repository: true })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'registration patch is empty');
export type RepositoryRegistrationPatch = z.infer<typeof RepositoryRegistrationPatch>;

export interface RepositoryRegistration extends RepositoryRegistrationInput {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const JobSource = z.object({
  kind: z.enum(['webhook', 'poll', 'manual', 'recovery']),
  key: z.string().min(1),
}).strict();
export type JobSource = z.infer<typeof JobSource>;

export const ArtifactReferenceContract = z.object({
  uri: z.string().regex(
    /^volume:\/\/registrations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9._/-]+$/,
    'artifact URI must be registration-scoped runner-volume URI',
  ).refine(
    (uri) => !uri.split('/').some((segment) => segment === '.' || segment === '..'),
    'artifact URI must not contain dot path segments',
  ),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
}).strict();
export type ArtifactReference = z.infer<typeof ArtifactReferenceContract>;

export const RunnerRepositoryIdentity = z.object({
  owner: RepositoryOwner,
  name: RepositoryName,
}).strict();
export type RunnerRepositoryIdentity = z.infer<typeof RunnerRepositoryIdentity>;

export const TriageJobPayloadV1Contract = z.object({
  schemaVersion: z.literal(1),
  repository: RunnerRepositoryIdentity,
  issue: z.object({
    number: z.number().int().positive().max(2_147_483_647),
    observedUpdatedAt: z.string().datetime({ offset: true }),
  }).strict(),
}).strict();
export type TriageJobPayloadV1 = z.infer<typeof TriageJobPayloadV1Contract>;

export const TriageDecisionV1Contract = z.object({
  schemaVersion: z.literal(1),
  type: z.enum(['feature', 'bug', 'tech_debt', 'question', 'documentation']),
  northStarAlignment: z.enum(['aligned', 'unclear', 'misaligned']),
  readiness: z.enum(['ready_candidate', 'blocked', 'needs_info']),
  priority: z.enum(['p0', 'p1', 'p2', 'p3']),
  summary: z.string().trim().min(1).max(500),
  rationale: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
  dependencies: z.array(z.object({
    repository: z.string().trim().toLowerCase()
      .pipe(CanonicalRepository),
    issueNumber: z.number().int().positive().max(2_147_483_647),
    relationship: z.enum(['blocks', 'blocked_by', 'relates_to']),
  }).strict()).max(16),
  duplicateCandidates: z.array(z.object({
    repository: z.string().trim().toLowerCase()
      .pipe(CanonicalRepository),
    issueNumber: z.number().int().positive().max(2_147_483_647),
    reason: z.string().trim().min(1).max(500),
  }).strict()).max(16),
  missingInformation: z.array(
    z.string().trim().min(1).max(500),
  ).max(16),
}).strict();
export type TriageDecisionV1 = z.infer<typeof TriageDecisionV1Contract>;

export const TriageProviderProvenanceContract = z.object({
  attemptId: z.string().uuid(),
  provider: z.string().min(1).max(128),
  model: ProviderModelSelectionContract,
  consumer: ReleaseRuntimeConsumerContract,
  environment: ReleaseRuntimeEnvironmentContract,
}).strict();
export type TriageProviderProvenance = z.infer<
  typeof TriageProviderProvenanceContract
>;

export const TriageJobResultV1Contract = z.object({
  schemaVersion: z.literal(1),
  status: z.literal('succeeded'),
  jobId: z.string().uuid(),
  attemptNumber: z.number().int().positive(),
  repository: CanonicalRepository,
  issueNumber: z.number().int().positive().max(2_147_483_647),
  outcome: z.enum(['triaged', 'unchanged', 'promoted', 'skipped']),
  sourceDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  decision: TriageDecisionV1Contract.nullable(),
  commentUrl: z.string().url().nullable(),
  appliedLabels: z.array(
    z.string().trim().min(1).max(50).regex(
      /^[a-zA-Z0-9][a-zA-Z0-9._:/ -]*$/,
    ),
  ).max(3),
  promotedJobId: z.string().uuid().nullable(),
  providerProvenance: TriageProviderProvenanceContract.nullable().default(null),
  completedAt: z.string().datetime(),
}).strict();
export type TriageJobResultV1 = z.infer<typeof TriageJobResultV1Contract>;

export const RunnerEventContract = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('issue'),
    number: z.number().int().positive(),
    action: z.enum(['opened', 'labeled', 'reopened', 'synchronize', 'recovery']),
  }).strict(),
  z.object({
    kind: z.literal('pull_request'),
    number: z.number().int().positive(),
    action: z.enum([
      'opened',
      'synchronize',
      'review_requested',
      'check_completed',
      'recovery',
    ]),
  }).strict(),
  z.object({
    kind: z.literal('repository'),
    trigger: z.enum(['push', 'check_run', 'check_suite']),
    identity: z.string().min(1).max(512).regex(/^\S(?:[\s\S]*\S)?$/),
    ref: z.string().max(255).optional(),
    after: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
  }).strict(),
]);
export type RunnerEvent = z.infer<typeof RunnerEventContract>;

const GitRef = z.string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !value.startsWith('-')
      && !value.includes('..')
      && !value.includes('@{')
      && !/[~^:?*\\\s]/.test(value)
      && !value.endsWith('/')
      && !value.endsWith('.lock'),
    'unsafe git ref',
  );
export const GitHubLabelNameContract = z.string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/ -]*$/);

/**
 * The only job payload executable by agentops-runner. It deliberately contains
 * repository/event/ref identities, never a shell command, host path, clone URL,
 * credential, or arbitrary process environment.
 */
export const RunnerJobPayloadV1Contract = z.object({
  schemaVersion: z.literal(1),
  repository: RunnerRepositoryIdentity,
  event: RunnerEventContract,
  target: z.object({
    baseRef: GitRef,
    headRef: GitRef.optional(),
  }).strict(),
  execution: z.object({
    mode: z.enum(['development_turn', 'pr_reconciliation']),
    requiredChecks: z.array(
      z.string().min(1).regex(/^\S(?:[\s\S]*\S)?$/),
    ).max(64),
    mergeMethod: z.enum(['squash', 'merge', 'rebase']),
    readyLabel: GitHubLabelNameContract,
    claimedLabel: GitHubLabelNameContract,
  }).strict(),
  artifacts: z.array(ArtifactReferenceContract).max(64),
}).strict().superRefine((payload, context) => {
  const expectedMode = payload.event.kind === 'issue'
    ? 'development_turn'
    : 'pr_reconciliation';
  if (payload.execution.mode !== expectedMode) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['execution', 'mode'],
      message: `${payload.event.kind} event requires ${expectedMode}`,
    });
  }
});
export type RunnerJobPayloadV1 = z.infer<typeof RunnerJobPayloadV1Contract>;

export const RunnerHumanReviewV1Contract = z.object({
  issueNumber: z.number().int().positive().max(2_147_483_647),
  reasonCount: z.number().int().positive(),
  commentUrl: z.string().url(),
  classification: z.literal('what-judgment'),
  howIntervention: z.literal(false),
  aiAppliedReadyLabel: z.literal(false),
  claimedLabelRemoved: z.literal(true),
}).strict();
export type RunnerHumanReviewV1 = z.infer<
  typeof RunnerHumanReviewV1Contract
>;

export const RunnerJobResultV1Contract = z.object({
  schemaVersion: z.literal(1),
  status: z.literal('succeeded'),
  jobId: z.string().uuid(),
  attemptNumber: z.number().int().positive(),
  repository: CanonicalRepository,
  outcome: z.enum(['completed', 'needs-human-review']).default('completed'),
  humanReview: RunnerHumanReviewV1Contract.nullable().default(null),
  headSha: z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),
  pullRequestNumber: z.number().int().positive().nullable(),
  artifacts: z.array(ArtifactReferenceContract),
  completedAt: z.string().datetime(),
}).strict().superRefine((result, context) => {
  if (result.outcome === 'needs-human-review') {
    if (result.humanReview === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['humanReview'],
        message: 'needs-human-review outcome requires human-review evidence',
      });
    }
    if (result.headSha !== null || result.pullRequestNumber !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['headSha'],
        message: 'needs-human-review outcome cannot claim a PR revision',
      });
    }
  } else if (result.humanReview !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['humanReview'],
      message: 'completed outcome cannot carry human-review evidence',
    });
  }
});
export type RunnerJobResultV1 = z.infer<typeof RunnerJobResultV1Contract>;

export const RunnerFailureCode = z.enum([
  'unknown_job_contract',
  'registration_stale',
  'lease_lost',
  'artifact_integrity',
  'workspace_failure',
  'provider_failure',
  'push_failure',
  'required_checks_failure',
  'merge_failure',
  'release_failure',
  'startup_isolation_failure',
  'internal_failure',
]);
export type RunnerFailureCode = z.infer<typeof RunnerFailureCode>;

export const RunnerCriticalBoundary = z.enum([
  'claim',
  'provider',
  'push',
  'merge',
  'release',
]);
export type RunnerCriticalBoundary = z.infer<typeof RunnerCriticalBoundary>;

export const RunnerJobFailureV1Contract = z.object({
  schemaVersion: z.literal(1),
  status: z.literal('failed'),
  code: RunnerFailureCode,
  message: z.string().min(1).max(2_000).regex(/^\S(?:[\s\S]*\S)?$/),
  retryable: z.boolean(),
  boundary: RunnerCriticalBoundary.nullable(),
  observedAt: z.string().datetime(),
}).strict();
export type RunnerJobFailureV1 = z.infer<typeof RunnerJobFailureV1Contract>;

export const EnqueueJobInput = z.object({
  registrationId: z.string().uuid(),
  registrationVersion: z.number().int().positive(),
  source: JobSource,
  idempotencyKey: z.string().trim().min(1),
  jobType: z.string().trim().min(1),
  payload: z.record(z.unknown()),
  availableAt: z.date().optional(),
}).superRefine((input, context) => {
  const contract = input.jobType === 'agentops.runner'
    ? RunnerJobPayloadV1Contract
    : input.jobType === 'agentops.triage'
      ? TriageJobPayloadV1Contract
      : null;
  if (!contract) return;
  const parsed = contract.safeParse(input.payload);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', ...issue.path],
        message: issue.message,
      });
    }
  }
});
export type EnqueueJobInput = z.infer<typeof EnqueueJobInput>;

export interface JobEnvelope {
  contractVersion: 1;
  id: string;
  registrationId: string;
  registrationVersion: number;
  source: JobSource;
  idempotencyKey: string;
  jobType: string;
  payload: Record<string, unknown>;
  status: 'queued' | 'leased' | 'succeeded' | 'failed' | 'cancelled' | 'rejected';
  createdAt: string;
  /** Durable release identity; optional only for legacy/non-release jobs. */
  releaseId?: string;
}

export const JobEnvelopeContract = z.object({
  contractVersion: z.literal(1),
  id: z.string().uuid(),
  registrationId: z.string().uuid(),
  registrationVersion: z.number().int().positive(),
  source: JobSource,
  idempotencyKey: z.string().min(1),
  jobType: z.string().min(1),
  payload: z.record(z.unknown()),
  status: z.enum(['queued', 'leased', 'succeeded', 'failed', 'cancelled', 'rejected']),
  createdAt: z.string().datetime(),
  releaseId: z.string().uuid().optional(),
}).strict();

export interface EnqueueResult {
  job: JobEnvelope;
  duplicate: boolean;
}

export interface Lease {
  id: string;
  token: string;
  workerId: string;
  attemptId: string;
  attemptNumber: number;
  expiresAt: string;
  job: JobEnvelope;
}

export interface ExecutionGuardVerdict {
  ok: boolean;
  reason: string | null;
  registration: RepositoryRegistration | null;
  jobId: string | null;
  leaseExpiresAt: string | null;
}

export interface ReconciliationWork {
  jobId: string;
  registrationId: string;
  repository: string;
  status: 'queued' | 'leased';
  availableAt: string;
  leaseExpiresAt: string | null;
}

export interface WebhookClaim {
  deliveryId: string;
  deliveryKey: string;
  repository: string;
  event: string;
  action: string | null;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
  token: string;
  expiresAt: string;
  receivedAt: string;
}

export interface BuildDefect {
  id: string;
  buildId: string;
  defectKey: string;
  observationStage: 'review_oracle' | 'release_escape';
  severity: 'low' | 'medium' | 'high' | 'critical';
  issueUrl: string | null;
  summary: string;
  discoveredAt: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ReleaseRecord {
  id: string;
  registrationId: string;
  releaseKey: string;
  repository: string;
  issueNumber: number;
  policy: ReleasePolicy;
  status: 'collecting' | 'merge-authorized' | 'merged';
  pullRequest: number | null;
  finalHead: string | null;
  mergeSha: string | null;
  mergeActor: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ReleaseReceiptOutboxEntry {
  receipt: DurableReleaseReceipt;
  publishedAt: string | null;
}

export class ControlStoreUnavailableError extends Error {
  override readonly name = 'ControlStoreUnavailableError';
}

export class ControlSchemaError extends Error {
  override readonly name = 'ControlSchemaError';
}

export class StaleRegistrationError extends Error {
  override readonly name = 'StaleRegistrationError';
}

export class RepositoryBusyError extends Error {
  override readonly name = 'RepositoryBusyError';
}

export class OperatingModeError extends Error {
  override readonly name = 'OperatingModeError';
}

export class IdempotencyConflictError extends Error {
  override readonly name = 'IdempotencyConflictError';
}

export class ReleaseReceiptConflictError extends Error {
  override readonly name = 'ReleaseReceiptConflictError';
}

export class ReleaseCertificationError extends Error {
  override readonly name = 'ReleaseCertificationError';
}

export class LeaseRejectedError extends Error {
  override readonly name = 'LeaseRejectedError';
}

export class RunnerContractError extends Error {
  override readonly name = 'RunnerContractError';
}
