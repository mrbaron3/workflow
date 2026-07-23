import {
  NormalizedGithubEvent,
  type NormalizedGithubEvent as NormalizedGithubEventType,
  type WebhookConsumerEvent,
  type WebhookConsumer,
  type WebhookDelivery,
} from './schema.js';
import { WebhookControlStore } from './store.js';

export type WebhookConsumerHandler = (event: WebhookConsumerEvent) => Promise<void> | void;
export type WebhookConsumerHandlers = Partial<Record<WebhookConsumer, WebhookConsumerHandler>>;

export class WebhookRouter {
  constructor(
    readonly store: WebhookControlStore,
    readonly consumers: WebhookConsumerHandlers,
  ) {}

  async route(deliveryId: string): Promise<WebhookDelivery> {
    const delivery = this.store.getDelivery(deliveryId);
    if (!delivery) throw new Error(`no such webhook delivery: ${deliveryId}`);
    if (delivery.status !== 'pending') return delivery;

    const registration = this.store.snapshot().repositories.find(
      (row) => row.enabled && row.repository.toLowerCase() === delivery.repository.toLowerCase(),
    );
    if (!registration) {
      return this.store.markIgnored(delivery.id, `repository is not registered or enabled: ${delivery.repository}`);
    }
    if (!registration.events.includes(delivery.event)) {
      return this.store.markIgnored(
        delivery.id,
        `event ${delivery.event} is not enabled for ${delivery.repository}`,
      );
    }

    const started = this.store.startDelivery(delivery.id, registration.id);
    if (!started) return this.store.getDelivery(delivery.id)!;
    const event = NormalizedGithubEvent.parse({
      deliveryId: started.id,
      deliveryKey: started.deliveryKey,
      registrationId: registration.id,
      repository: started.repository,
      event: started.event,
      action: started.action,
      payload: started.payload,
      receivedAt: started.receivedAt,
      source: 'webhook',
    });

    try {
      for (const consumer of registration.consumers) {
        const handler = this.consumers[consumer];
        if (!handler) throw new Error(`consumer adapter is not configured: ${consumer}`);
        await handler(event);
      }
      return this.store.markProcessed(delivery.id);
    } catch (error) {
      return this.store.markFailed(
        delivery.id,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async retry(deliveryId: string): Promise<WebhookDelivery> {
    this.store.retryDelivery(deliveryId);
    return this.route(deliveryId);
  }
}
