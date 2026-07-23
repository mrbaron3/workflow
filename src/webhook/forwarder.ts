import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
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
  hookUrl: string,
) => GithubWebhookForwarderProcess;

export interface GithubWebhookForwarderSupervisorOptions {
  hookUrl: string;
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
  return (registration, hookUrl) => {
    const child = spawnProcess('gh', [
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

export const MAX_RELAY_BODY_BYTES = 10 * 1024 * 1024;

/**
 * `gh webhook forward` only accepts --secret on argv. Keep the verifier secret
 * out of child process metadata by forwarding unsigned loopback traffic into
 * this in-process relay, which signs the exact raw body before it reaches /hook.
 */
export class GithubWebhookSigningRelay {
  private server: Server | null = null;

  constructor(
    private readonly upstreamHookUrl: string,
    private readonly webhookSecret: string,
  ) {
    if (!webhookSecret.trim()) throw new Error('non-empty webhookSecret is required');
  }

  listen(): Promise<string> {
    if (this.server) throw new Error('webhook signing relay is already listening');
    this.server = createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/forward') {
        response.writeHead(404).end('not found');
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      request.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_RELAY_BODY_BYTES) {
          response.writeHead(413).end('payload too large');
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => {
        if (bytes > MAX_RELAY_BODY_BYTES) return;
        const body = Buffer.concat(chunks);
        const signature = `sha256=${createHmac('sha256', this.webhookSecret)
          .update(body)
          .digest('hex')}`;
        const headers = new Headers({
          'content-type': String(request.headers['content-type'] ?? 'application/json'),
          'x-hub-signature-256': signature,
        });
        for (const name of ['x-github-event', 'x-github-delivery']) {
          const value = request.headers[name];
          if (typeof value === 'string') headers.set(name, value);
        }
        void fetch(this.upstreamHookUrl, {
          method: 'POST',
          headers,
          body,
          redirect: 'error',
        }).then(async (upstream) => {
          response.writeHead(upstream.status, {
            'content-type': upstream.headers.get('content-type') ?? 'text/plain',
          });
          response.end(await upstream.text());
        }).catch(() => {
          response.writeHead(502).end('webhook relay failed');
        });
      });
    });
    return new Promise((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error) => {
        server.removeListener('listening', onListening);
        this.server = null;
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('webhook signing relay did not bind a TCP address'));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}/forward`);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });
  }

  close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
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
      const process = this.spawnForwarder(registration, this.options.hookUrl);
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
