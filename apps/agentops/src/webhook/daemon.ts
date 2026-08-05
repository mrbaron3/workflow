import { DEFAULT_WEBHOOK_RECONCILIATION_INTERVAL_MS } from './reconciliation.js';
import { DEFAULT_WEBHOOK_CONTROL_PORT } from './server.js';

export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface WebhookDaemonOptions {
  host: '127.0.0.1' | '::1';
  port: number;
  reconciliationIntervalMs: number;
  controlToken: string;
  webhookSecret: string;
  orcaSyncScript?: string;
  forward: boolean;
  reconcile: boolean;
  open: boolean;
}

export interface WebhookDaemonResources {
  reconciliation: { stop(): void };
  forwarders: { stop(): void };
  consumers: { abort(): void };
  signingRelay: { close(): Promise<void> };
  control: { close(): Promise<void> };
}

export interface WebhookDaemonSignalSource {
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

/** Wait for either termination signal and close every started resource exactly once. */
export function waitForWebhookDaemonShutdown(
  resources: WebhookDaemonResources,
  signals: WebhookDaemonSignalSource = process,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      signals.removeListener('SIGINT', stop);
      signals.removeListener('SIGTERM', stop);
      try {
        resources.reconciliation.stop();
        resources.forwarders.stop();
        resources.consumers.abort();
        void resources.signingRelay.close()
          .then(() => resources.control.close())
          .then(resolve, reject);
      } catch (error) {
        reject(error);
      }
    };
    signals.once('SIGINT', stop);
    signals.once('SIGTERM', stop);
  });
}

export function parseWebhookDaemonOptions(
  flags: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv,
): WebhookDaemonOptions {
  const host = typeof flags.host === 'string' ? flags.host : '127.0.0.1';
  const port = typeof flags.port === 'string' ? Number(flags.port) : DEFAULT_WEBHOOK_CONTROL_PORT;
  const reconciliationIntervalMs = typeof flags['reconcile-interval-ms'] === 'string'
    ? Number(flags['reconcile-interval-ms'])
    : DEFAULT_WEBHOOK_RECONCILIATION_INTERVAL_MS;
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('webhook-daemon is loopback-only; remote binding is not supported');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('--port must be an integer between 0 and 65535');
  }
  if (
    !Number.isInteger(reconciliationIntervalMs)
    || reconciliationIntervalMs <= 0
    || reconciliationIntervalMs > MAX_TIMER_DELAY_MS
  ) {
    throw new Error('--reconcile-interval-ms must be a positive timer-safe integer');
  }
  const controlToken = env.AGENTOPS_WEBHOOK_CONTROL_TOKEN?.trim();
  const webhookSecret = env.AGENTOPS_GITHUB_WEBHOOK_SECRET?.trim();
  if (!controlToken) {
    throw new Error('AGENTOPS_WEBHOOK_CONTROL_TOKEN must be set to a non-empty value');
  }
  if (!webhookSecret) {
    throw new Error('AGENTOPS_GITHUB_WEBHOOK_SECRET must be set to a non-empty value');
  }
  return {
    host,
    port,
    reconciliationIntervalMs,
    controlToken,
    webhookSecret,
    ...(typeof flags['orca-sync-script'] === 'string'
      ? { orcaSyncScript: flags['orca-sync-script'] }
      : env.AGENTOPS_ORCA_SYNC_SCRIPT
        ? { orcaSyncScript: env.AGENTOPS_ORCA_SYNC_SCRIPT }
        : {}),
    forward: !flags['no-forward'],
    reconcile: !flags['no-reconcile'],
    open: Boolean(flags.open),
  };
}
