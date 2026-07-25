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

const WebhookDeliveryBase = z.object({
  id: z.string().min(1),
  deliveryKey: z.string().min(1),
  repository: RepositoryName,
  event: WebhookEvent,
  action: z.string().nullable().default(null),
  headers: z.record(z.string()).default({}),
  payload: z.record(z.unknown()),
  attempts: z.number().int().nonnegative().default(0),
  receivedAt: z.string(),
  updatedAt: z.string(),
});
const UnroutedPendingWebhookDelivery = WebhookDeliveryBase.extend({
  status: z.literal('pending').default('pending'),
  registrationId: z.null().default(null),
  plannedConsumers: z.tuple([]).default([]),
  completedConsumers: z.tuple([]).default([]),
  lastError: z.null().default(null),
  ignoredReason: z.null().default(null),
});
export const WebhookRoutePlan = z.object({
  registrationId: z.string().min(1),
  consumers: z.array(WebhookConsumer).min(1).refine(uniqueValues, 'consumers must be unique'),
});
export type WebhookRoutePlan = z.infer<typeof WebhookRoutePlan>;
const RoutedWebhookDeliveryBase = WebhookDeliveryBase.extend({
  registrationId: z.string().min(1),
  plannedConsumers: z.array(WebhookConsumer)
    .min(1)
    .refine(uniqueValues, 'plannedConsumers must be unique'),
  completedConsumers: z.array(WebhookConsumer)
    .refine(uniqueValues, 'completedConsumers must be unique')
    .default([]),
  lastError: z.null().default(null),
  ignoredReason: z.null().default(null),
});
function completedConsumersBelongToPlan(
  delivery: {
    completedConsumers: readonly WebhookConsumer[];
    plannedConsumers: readonly WebhookConsumer[];
  },
): boolean {
  return delivery.completedConsumers.every(
    (consumer) => delivery.plannedConsumers.includes(consumer),
  );
}
export const RetryPendingWebhookDelivery = RoutedWebhookDeliveryBase.extend({
  status: z.literal('pending'),
}).refine(completedConsumersBelongToPlan, {
  message: 'completedConsumers must belong to plannedConsumers',
});
const PendingWebhookDelivery = z.union([
  UnroutedPendingWebhookDelivery,
  RetryPendingWebhookDelivery,
]);
export const ProcessingWebhookDelivery = RoutedWebhookDeliveryBase.extend({
  status: z.literal('processing'),
}).refine(completedConsumersBelongToPlan, {
  message: 'completedConsumers must belong to plannedConsumers',
});
export const ProcessedWebhookDelivery = RoutedWebhookDeliveryBase.extend({
  status: z.literal('processed'),
}).refine(
  (delivery) => completedConsumersBelongToPlan(delivery)
    && delivery.plannedConsumers.every(
      (consumer) => delivery.completedConsumers.includes(consumer),
    ),
  { message: 'processed deliveries require every planned consumer to be completed' },
);
export const FailedWebhookDelivery = RoutedWebhookDeliveryBase.extend({
  status: z.literal('failed'),
  lastError: z.string().min(1),
}).refine(completedConsumersBelongToPlan, {
  message: 'completedConsumers must belong to plannedConsumers',
});
export const IgnoredWebhookDelivery = WebhookDeliveryBase.extend({
  status: z.literal('ignored'),
  registrationId: z.null().default(null),
  plannedConsumers: z.tuple([]).default([]),
  completedConsumers: z.tuple([]).default([]),
  lastError: z.null().default(null),
  ignoredReason: z.string().min(1),
});
export const WebhookDelivery = z.union([
  PendingWebhookDelivery,
  ProcessingWebhookDelivery,
  ProcessedWebhookDelivery,
  FailedWebhookDelivery,
  IgnoredWebhookDelivery,
]);
export type WebhookDelivery = Readonly<z.infer<typeof WebhookDelivery>>;

export const WebhookControlDB = z.object({
  version: z.literal(1).default(1),
  counters: z.record(z.number().int().nonnegative()).default({}),
  repositories: z.array(WebhookRepositoryRegistration).default([]),
  deliveries: z.array(WebhookDelivery).default([]).readonly(),
});
type ParsedWebhookControlDB = z.infer<typeof WebhookControlDB>;
export type WebhookControlDB = Omit<ParsedWebhookControlDB, 'deliveries'> & {
  readonly deliveries: readonly WebhookDelivery[];
};

export function emptyWebhookControlDB(): WebhookControlDB {
  return WebhookControlDB.parse({});
}

export function startWebhookDelivery(
  delivery: z.infer<typeof PendingWebhookDelivery>,
  routePlan: WebhookRoutePlan,
  updatedAt: string,
): Readonly<z.infer<typeof ProcessingWebhookDelivery>> {
  if (
    delivery.registrationId !== null
    && (
      delivery.registrationId !== routePlan.registrationId
      || delivery.plannedConsumers.length !== routePlan.consumers.length
      || delivery.plannedConsumers.some(
        (consumer, index) => consumer !== routePlan.consumers[index],
      )
    )
  ) {
    throw new Error(`retry route plan changed for delivery ${delivery.id}`);
  }
  return ProcessingWebhookDelivery.parse({
    ...delivery,
    status: 'processing',
    registrationId: routePlan.registrationId,
    plannedConsumers: [...routePlan.consumers],
    attempts: delivery.attempts + 1,
    updatedAt,
  });
}

export function processWebhookDelivery(
  delivery: z.infer<typeof ProcessingWebhookDelivery>,
  updatedAt: string,
): Readonly<z.infer<typeof ProcessedWebhookDelivery>> {
  return ProcessedWebhookDelivery.parse({ ...delivery, status: 'processed', updatedAt });
}

export function failWebhookDelivery(
  delivery: z.infer<typeof ProcessingWebhookDelivery>,
  lastError: string,
  updatedAt: string,
): Readonly<z.infer<typeof FailedWebhookDelivery>> {
  return FailedWebhookDelivery.parse({ ...delivery, status: 'failed', lastError, updatedAt });
}

export function completeWebhookConsumer(
  delivery: z.infer<typeof ProcessingWebhookDelivery>,
  consumer: WebhookConsumer,
  updatedAt: string,
): Readonly<z.infer<typeof ProcessingWebhookDelivery>> {
  return ProcessingWebhookDelivery.parse({
    ...delivery,
    completedConsumers: delivery.completedConsumers.includes(consumer)
      ? delivery.completedConsumers
      : [...delivery.completedConsumers, consumer],
    updatedAt,
  });
}

export function ignoreWebhookDelivery(
  delivery: z.infer<typeof UnroutedPendingWebhookDelivery>,
  ignoredReason: string,
  updatedAt: string,
): Readonly<z.infer<typeof IgnoredWebhookDelivery>> {
  return IgnoredWebhookDelivery.parse({ ...delivery, status: 'ignored', ignoredReason, updatedAt });
}

export function retryWebhookDelivery(
  delivery: z.infer<typeof FailedWebhookDelivery>,
  updatedAt: string,
): Readonly<z.infer<typeof RetryPendingWebhookDelivery>> {
  return RetryPendingWebhookDelivery.parse({
    ...delivery,
    status: 'pending',
    lastError: null,
    updatedAt,
  });
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
  source: z.literal('webhook').default('webhook'),
});
export type NormalizedGithubEvent = z.infer<typeof NormalizedGithubEvent>;

export const ReconciliationEvent = z.object({
  source: z.literal('reconciliation'),
  registrationId: z.string(),
  repository: RepositoryName,
});
export type ReconciliationEvent = z.infer<typeof ReconciliationEvent>;

export const WebhookConsumerEvent = z.union([NormalizedGithubEvent, ReconciliationEvent]);
export type WebhookConsumerEvent = z.infer<typeof WebhookConsumerEvent>;
