import { ReconciliationEvent } from './schema.js';
import type { WebhookConsumerHandler } from './router.js';
import { WebhookControlStore } from './store.js';

export const DEFAULT_WEBHOOK_RECONCILIATION_INTERVAL_MS = 30_000;

export interface WebhookReconciliationSchedulerOptions {
  intervalMs?: number;
  log?: (message: string) => void;
}

/** Poll fallback sharing the same per-repository AgentOps consumer single-flight as webhooks. */
export class WebhookReconciliationScheduler {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly log: (message: string) => void;

  constructor(
    readonly store: WebhookControlStore,
    readonly consume: WebhookConsumerHandler,
    readonly options: WebhookReconciliationSchedulerOptions = {},
  ) {
    this.log = options.log ?? (() => {});
  }

  tick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const running = this.runTick().finally(() => {
      if (this.inFlight === running) this.inFlight = null;
    });
    this.inFlight = running;
    return running;
  }

  private async runTick(): Promise<void> {
    const registrations = this.store.snapshot().repositories.filter(
      (row) => row.enabled && row.consumers.includes('agentops'),
    );
    await Promise.all(registrations.map(async (registration) => {
      const event = ReconciliationEvent.parse({
        registrationId: registration.id,
        repository: registration.repository,
        source: 'reconciliation',
      });
      try {
        await this.consume(event);
      } catch (error) {
        this.log(
          `reconciliation failed for ${registration.repository}: `
          + (error instanceof Error ? error.message : String(error)),
        );
      }
    }));
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = this.options.intervalMs ?? DEFAULT_WEBHOOK_RECONCILIATION_INTERVAL_MS;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
