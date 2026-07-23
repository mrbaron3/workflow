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

    let routePlan;
    if (delivery.registrationId === null) {
      const registration = this.store.snapshot().repositories.find(
        (row) =>
          row.enabled
          && row.repository.toLowerCase() === delivery.repository.toLowerCase(),
      );
      if (!registration) {
        return this.store.markIgnored(
          delivery.id,
          `repository is not registered or enabled: ${delivery.repository}`,
        );
      }
      if (!registration.events.includes(delivery.event)) {
        return this.store.markIgnored(
          delivery.id,
          `event ${delivery.event} is not enabled for ${delivery.repository}`,
        );
      }
      routePlan = {
        registrationId: registration.id,
        consumers: registration.consumers,
      };
    } else {
      routePlan = {
        registrationId: delivery.registrationId,
        consumers: delivery.plannedConsumers,
      };
    }

    const started = this.store.startDelivery(delivery.id, routePlan);
    if (!started) return this.store.getDelivery(delivery.id)!;
    if (started.status !== 'processing') {
      throw new Error(`delivery ${delivery.id} did not enter processing`);
    }
    const event = NormalizedGithubEvent.parse({
      deliveryId: started.id,
      deliveryKey: started.deliveryKey,
      registrationId: started.registrationId,
      repository: started.repository,
      event: started.event,
      action: started.action,
      payload: started.payload,
      receivedAt: started.receivedAt,
      source: 'webhook',
    });

    try {
      for (const consumer of started.plannedConsumers) {
        if (started.completedConsumers.includes(consumer)) continue;
        const handler = this.consumers[consumer];
        if (!handler) throw new Error(`consumer adapter is not configured: ${consumer}`);
        await handler(event);
        this.store.markConsumerCompleted(delivery.id, consumer);
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
