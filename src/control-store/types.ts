import { z } from 'zod';

export const CONTROL_SCHEMA_VERSION = 1;

export const RepositoryRegistrationInput = z.object({
  repository: z.string().trim().toLowerCase()
    .regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
  enabled: z.boolean().default(true),
  issueMonitorEnabled: z.boolean().default(true),
  prMonitorEnabled: z.boolean().default(true),
  executionEnabled: z.boolean().default(true),
  configuration: z.record(z.unknown()).default({}),
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
});
export type JobSource = z.infer<typeof JobSource>;

export const EnqueueJobInput = z.object({
  registrationId: z.string().uuid(),
  registrationVersion: z.number().int().positive(),
  source: JobSource,
  idempotencyKey: z.string().trim().min(1),
  jobType: z.string().trim().min(1),
  payload: z.record(z.unknown()),
  availableAt: z.date().optional(),
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
  createdAt: z.string().datetime(),
});

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

export interface ReconciliationWork {
  jobId: string;
  registrationId: string;
  repository: string;
  status: 'queued' | 'leased';
  availableAt: string;
  leaseExpiresAt: string | null;
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

export class LeaseRejectedError extends Error {
  override readonly name = 'LeaseRejectedError';
}
