import { spawn, type ChildProcess } from 'node:child_process';
import type { WebhookRepositoryRegistration } from './schema.js';
import { WebhookControlStore } from './store.js';

export interface GithubWebhookForwarderProcess {
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
}

export type SpawnGithubWebhookForwarder = (
  registration: WebhookRepositoryRegistration,
  hookUrl: string,
) => GithubWebhookForwarderProcess;

export interface GithubWebhookForwarderSupervisorOptions {
  hookUrl: string;
  reconcileIntervalMs?: number;
  spawnForwarder?: SpawnGithubWebhookForwarder;
  log?: (message: string) => void;
}

interface RunningForwarder {
  fingerprint: string;
  process: GithubWebhookForwarderProcess;
}

function fingerprint(registration: WebhookRepositoryRegistration): string {
  return JSON.stringify({
    repository: registration.repository,
    events: [...registration.events].sort(),
  });
}

function productionSpawner(
  log: (message: string) => void,
): SpawnGithubWebhookForwarder {
  return (registration, hookUrl) => {
    const child: ChildProcess = spawn('gh', [
      'webhook',
      'forward',
      `--repo=${registration.repository}`,
      `--events=${registration.events.join(',')}`,
      `--url=${hookUrl}`,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const message = String(chunk).trim();
      if (message) log(`[${registration.repository}] ${message}`);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const message = String(chunk).trim();
      if (message) log(`[${registration.repository}] ${message}`);
    });
    return child;
  };
}

/**
 * Keeps one `gh webhook forward` child per enabled registration. Reconciliation,
 * not callbacks from the GUI, is the source of truth, so external edits to the
 * durable registry are picked up as well.
 */
export class GithubWebhookForwarderSupervisor {
  readonly running = new Map<string, RunningForwarder>();
  private readonly spawnForwarder: SpawnGithubWebhookForwarder;
  private readonly log: (message: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(
    readonly store: WebhookControlStore,
    readonly options: GithubWebhookForwarderSupervisorOptions,
  ) {
    this.log = options.log ?? (() => {});
    this.spawnForwarder = options.spawnForwarder ?? productionSpawner(this.log);
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
      const process = this.spawnForwarder(registration, this.options.hookUrl);
      const running = { fingerprint: fingerprint(registration), process };
      this.running.set(id, running);
      process.once('exit', (code, signal) => {
        if (this.running.get(id)?.process !== process) return;
        this.running.delete(id);
        this.log(
          `forwarder exited: ${registration.repository} `
          + `(code=${code === null ? 'null' : code}, signal=${signal ?? 'none'})`,
        );
      });
      process.once('error', (error) => {
        if (this.running.get(id)?.process !== process) return;
        this.running.delete(id);
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
    const interval = this.options.reconcileIntervalMs ?? 5_000;
    this.timer = setInterval(() => {
      try {
        this.reconcile();
      } catch (error) {
        this.log(`forwarder reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, interval);
    this.timer.unref();
  }

  status(): Array<{ registrationId: string; state: 'running' | 'stopped' }> {
    return this.store.snapshot().repositories.map((registration) => ({
      registrationId: registration.id,
      state: this.running.has(registration.id) ? 'running' : 'stopped',
    }));
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
