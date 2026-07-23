import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import type { WebhookRepositoryRegistration } from './schema.js';
import { WebhookControlStore } from './store.js';

export interface GithubWebhookForwarderProcess {
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  stdout?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
}

export type SpawnGithubWebhookForwarder = (
  registration: WebhookRepositoryRegistration,
  forwardEvent: TrustedGithubEventSink,
) => GithubWebhookForwarderProcess;

export interface TrustedGithubEvent {
  body: Buffer;
  event: string;
  delivery: string;
}
export type TrustedGithubEventSink = (event: TrustedGithubEvent) => Promise<void>;

export interface GithubWebhookForwarderSupervisorOptions {
  forwardEvent: TrustedGithubEventSink;
  reconcileIntervalMs?: number;
  spawnForwarder?: SpawnGithubWebhookForwarder;
  log?: (message: string) => void;
}
export const DEFAULT_FORWARDER_RECONCILE_INTERVAL_MS = 5_000;

interface RunningForwarder {
  fingerprint: string;
  process: GithubWebhookForwarderProcess;
}

interface ForwarderFailure {
  error: string;
  failedAt: string;
}

function fingerprint(registration: WebhookRepositoryRegistration): string {
  return JSON.stringify({
    repository: registration.repository,
    events: [...registration.events].sort(),
  });
}

type ForwarderSpawn = (
  executable: string,
  args: readonly string[],
  options: { stdio: ['ignore', 'pipe', 'pipe'] },
) => GithubWebhookForwarderProcess;

export function productionGithubWebhookForwarderSpawner(
  log: (message: string) => void,
  spawnProcess: ForwarderSpawn = spawn as ForwarderSpawn,
): SpawnGithubWebhookForwarder {
  return (registration, forwardEvent) => {
    const child = spawnProcess('gh', [
      'webhook',
      'forward',
      `--repo=${registration.repository}`,
      `--events=${registration.events.join(',')}`,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pending = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      pending += String(chunk);
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const raw = line.trim();
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const body = Buffer.from(line);
          const event = parsed.pull_request ? 'pull_request'
            : parsed.issue ? 'issues'
              : registration.events.length === 1 ? registration.events[0]! : '';
          if (!event) {
            log(`[${registration.repository}] discarded event with ambiguous type`);
            continue;
          }
          void forwardEvent({ body, event, delivery: randomUUID() }).catch((error: unknown) => {
            log(`[${registration.repository}] secure forward failed: ${
              error instanceof Error ? error.message : String(error)
            }`);
          });
        } catch {
          log(`[${registration.repository}] ignored non-payload forwarder output`);
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const message = String(chunk).trim();
      if (message) log(`[${registration.repository}] ${message}`);
    });
    return child;
  };
}

export const MAX_RELAY_BODY_BYTES = 10 * 1024 * 1024;
export function isRelayBodyWithinLimit(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= MAX_RELAY_BODY_BYTES;
}

/** Signs only events received over the child process' private stdout pipe. */
export class GithubWebhookSigningRelay {
  constructor(
    private readonly upstreamHookUrl: string,
    private readonly webhookSecret: string,
    private readonly request: typeof fetch = fetch,
  ) {
    if (!webhookSecret.trim()) throw new Error('non-empty webhookSecret is required');
  }

  async forwardTrustedEvent(event: TrustedGithubEvent): Promise<Response> {
    if (!isRelayBodyWithinLimit(event.body.length)) {
      throw new Error('payload too large');
    }
    const signature = `sha256=${createHmac('sha256', this.webhookSecret)
      .update(event.body)
      .digest('hex')}`;
    return this.request(this.upstreamHookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-event': event.event,
        'x-github-delivery': event.delivery,
      },
      body: event.body,
      redirect: 'error',
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Keeps one `gh webhook forward` child per enabled registration. Reconciliation,
 * not callbacks from the GUI, is the source of truth, so external edits to the
 * durable registry are picked up as well.
 */
export class GithubWebhookForwarderSupervisor {
  readonly running = new Map<string, RunningForwarder>();
  private readonly failures = new Map<string, ForwarderFailure>();
  private readonly spawnForwarder: SpawnGithubWebhookForwarder;
  private readonly log: (message: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(
    readonly store: WebhookControlStore,
    readonly options: GithubWebhookForwarderSupervisorOptions,
  ) {
    this.log = options.log ?? (() => {});
    this.spawnForwarder = options.spawnForwarder
      ?? productionGithubWebhookForwarderSpawner(this.log);
  }

  reconcile(): void {
    const registrations = this.store.snapshot().repositories;
    const desired = new Map(
      registrations
        .filter((registration) => registration.enabled)
        .map((registration) => [registration.id, registration]),
    );

    for (const [id, running] of this.running) {
      const registration = desired.get(id);
      if (!registration || fingerprint(registration) !== running.fingerprint) {
        this.running.delete(id);
        running.process.kill('SIGTERM');
        this.log(`forwarder stopped: ${id}`);
      }
    }

    for (const [id, registration] of desired) {
      if (this.running.has(id)) continue;
      this.failures.delete(id);
      const process = this.spawnForwarder(registration, this.options.forwardEvent);
      const running = { fingerprint: fingerprint(registration), process };
      this.running.set(id, running);
      process.once('exit', (code, signal) => {
        if (this.running.get(id)?.process !== process) return;
        this.running.delete(id);
        this.failures.set(id, {
          error: `exited (code=${code === null ? 'null' : code}, signal=${signal ?? 'none'})`,
          failedAt: new Date().toISOString(),
        });
        this.log(
          `forwarder exited: ${registration.repository} `
          + `(code=${code === null ? 'null' : code}, signal=${signal ?? 'none'})`,
        );
      });
      process.once('error', (error) => {
        if (this.running.get(id)?.process !== process) return;
        this.running.delete(id);
        this.failures.set(id, {
          error: error.message,
          failedAt: new Date().toISOString(),
        });
        this.log(`forwarder failed: ${registration.repository} (${error.message})`);
      });
      this.log(
        `forwarder started: ${registration.repository} `
        + `[${registration.events.join(',')}]`,
      );
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconcile();
    const interval = this.options.reconcileIntervalMs ?? DEFAULT_FORWARDER_RECONCILE_INTERVAL_MS;
    this.timer = setInterval(() => {
      try {
        this.reconcile();
      } catch (error) {
        this.log(`forwarder reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, interval);
    this.timer.unref();
  }

  status(): Array<{
    registrationId: string;
    state: 'running' | 'disabled' | 'failed' | 'stopped';
    error?: string;
    failedAt?: string;
  }> {
    return this.store.snapshot().repositories.map((registration) => {
      const failure = this.failures.get(registration.id);
      const state = this.running.has(registration.id)
        ? 'running'
        : failure
          ? 'failed'
          : !registration.enabled || this.stopped
            ? 'disabled'
            : 'stopped';
      return {
        registrationId: registration.id,
        state,
        ...(failure ?? {}),
      };
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const [id, running] of this.running) {
      this.running.delete(id);
      running.process.kill('SIGTERM');
    }
  }
}
