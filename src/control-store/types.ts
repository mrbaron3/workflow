import { z } from 'zod';

export const CONTROL_SCHEMA_VERSION = 5;

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

export const RepositoryRegistrationInput = z.object({
  repository: z.string().trim().toLowerCase()
    .regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
  enabled: z.boolean().default(true),
  issueMonitorEnabled: z.boolean().default(true),
  prMonitorEnabled: z.boolean().default(true),
  executionEnabled: z.boolean().default(true),
  configuration: z.object({}).strict().default({}),
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
  owner: z.string().regex(/^[a-z0-9_.-]+$/),
  name: z.string().regex(/^[a-z0-9_.-]+$/),
}).strict();
export type RunnerRepositoryIdentity = z.infer<typeof RunnerRepositoryIdentity>;

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

export const RunnerJobResultV1Contract = z.object({
  schemaVersion: z.literal(1),
  status: z.literal('succeeded'),
  jobId: z.string().uuid(),
  attemptNumber: z.number().int().positive(),
  repository: z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
  headSha: z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),
  pullRequestNumber: z.number().int().positive().nullable(),
  artifacts: z.array(ArtifactReferenceContract),
  completedAt: z.string().datetime(),
}).strict();
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
  if (input.jobType !== 'agentops.runner') return;
  const parsed = RunnerJobPayloadV1Contract.safeParse(input.payload);
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

export class LeaseRejectedError extends Error {
  override readonly name = 'LeaseRejectedError';
}

export class RunnerContractError extends Error {
  override readonly name = 'RunnerContractError';
}
