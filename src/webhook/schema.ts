import { z } from 'zod';

export const WebhookEvent = z.enum([
  'issues',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'check_run',
  'check_suite',
  'push',
  'issue_comment',
]);
export type WebhookEvent = z.infer<typeof WebhookEvent>;

export const WebhookConsumer = z.enum(['agentops', 'orca-worktree-sync']);
export type WebhookConsumer = z.infer<typeof WebhookConsumer>;

export const RepositoryName = z.string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'repository must be owner/name');

function uniqueValues<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

export const WebhookRepositoryRegistrationInput = z.object({
  repository: RepositoryName,
  enabled: z.boolean().default(true),
  events: z.array(WebhookEvent).min(1).refine(uniqueValues, 'events must be unique'),
  consumers: z.array(WebhookConsumer).min(1).refine(uniqueValues, 'consumers must be unique'),
  workspaceRoot: z.string().trim().min(1).nullable().default(null),
  readyLabel: z.string().trim().min(1).nullable().default(null),
  baseBranch: z.string().trim().min(1).nullable().default(null),
});
export type WebhookRepositoryRegistrationInput = z.infer<typeof WebhookRepositoryRegistrationInput>;

export const WebhookRepositoryRegistrationPatch = WebhookRepositoryRegistrationInput
  .omit({ repository: true })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'patch must change at least one field');
export type WebhookRepositoryRegistrationPatch = z.infer<typeof WebhookRepositoryRegistrationPatch>;

export const WebhookRepositoryRegistration = WebhookRepositoryRegistrationInput.extend({
  id: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WebhookRepositoryRegistration = z.infer<typeof WebhookRepositoryRegistration>;

export const WebhookDeliveryStatus = z.enum([
  'pending',
  'processing',
  'processed',
  'ignored',
  'failed',
]);
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatus>;

export const WebhookDelivery = z.object({
  id: z.string().min(1),
  deliveryKey: z.string().min(1),
  repository: RepositoryName,
  event: WebhookEvent,
  action: z.string().nullable().default(null),
  headers: z.record(z.string()).default({}),
  payload: z.record(z.unknown()),
  registrationId: z.string().nullable().default(null),
  status: WebhookDeliveryStatus.default('pending'),
  attempts: z.number().int().nonnegative().default(0),
  lastError: z.string().nullable().default(null),
  ignoredReason: z.string().nullable().default(null),
  receivedAt: z.string(),
  updatedAt: z.string(),
});
export type WebhookDelivery = z.infer<typeof WebhookDelivery>;

export const WebhookControlDB = z.object({
  version: z.literal(1).default(1),
  counters: z.record(z.number().int().nonnegative()).default({}),
  repositories: z.array(WebhookRepositoryRegistration).default([]),
  deliveries: z.array(WebhookDelivery).default([]),
});
export type WebhookControlDB = z.infer<typeof WebhookControlDB>;

export function emptyWebhookControlDB(): WebhookControlDB {
  return WebhookControlDB.parse({});
}

export const WebhookReceipt = z.object({
  deliveryId: z.string(),
  duplicate: z.boolean(),
  status: WebhookDeliveryStatus,
});
export type WebhookReceipt = z.infer<typeof WebhookReceipt>;

export const NormalizedGithubEvent = z.object({
  deliveryId: z.string(),
  deliveryKey: z.string(),
  registrationId: z.string(),
  repository: RepositoryName,
  event: WebhookEvent,
  action: z.string().nullable(),
  payload: z.record(z.unknown()),
  receivedAt: z.string(),
  source: z.enum(['webhook', 'reconciliation']).default('webhook'),
});
export type NormalizedGithubEvent = z.infer<typeof NormalizedGithubEvent>;
