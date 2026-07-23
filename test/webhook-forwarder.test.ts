import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GithubWebhookForwarderSupervisor,
  GithubWebhookSigningRelay,
  productionGithubWebhookForwarderSpawner,
  type GithubWebhookForwarderProcess,
} from '../src/webhook/forwarder.js';
import type { WebhookRepositoryRegistration } from '../src/webhook/schema.js';
import { WebhookControlStore } from '../src/webhook/store.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-forwarder-'));
  roots.push(root);
  return root;
}

class FakeProcess extends EventEmitter implements GithubWebhookForwarderProcess {
  killed: NodeJS.Signals[] = [];
  stdout = new EventEmitter();
  stderr = new EventEmitter();

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal);
    return true;
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('multi-repository GitHub webhook forwarders', () => {
  it('ISSUE-0024/PR-INTENT never places the verifier secret in gh argv or logs', () => {
    const calls: Array<{ executable: string; args: string[] }> = [];
    const logs: string[] = [];
    const secret = 'same-secret-as-verifier';
    const process = new FakeProcess();
    const spawn = productionGithubWebhookForwarderSpawner(
      (message) => logs.push(message),
      ((executable: string, args: readonly string[]) => {
        calls.push({ executable, args: [...args] });
        return process;
      }),
    );
    const registration: WebhookRepositoryRegistration = {
      id: 'WHREPO-0001',
      repository: 'acme/theme',
      enabled: true,
      events: ['pull_request'],
      consumers: ['agentops'],
      workspaceRoot: null,
      readyLabel: null,
      baseBranch: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    spawn(registration, 'http://127.0.0.1:8377/hook');
    process.stderr.emit('data', 'forwarder configured');

    expect(calls[0]).toEqual(expect.objectContaining({
      executable: 'gh',
      args: expect.not.arrayContaining([expect.stringContaining(secret)]),
    }));
    expect(calls[0]!.args).not.toEqual(expect.arrayContaining([expect.stringContaining('--secret')]));
    expect(logs.join('\n')).not.toContain(secret);
  });

  it('ISSUE-0024/PR-INTENT signs unsigned gh traffic inside the daemon process', async () => {
    const secret = 'relay-only-secret';
    const payload = Buffer.from('{"action":"opened"}');
    let observedSignature = '';
    const upstream = createServer((request, response) => {
      observedSignature = String(request.headers['x-hub-signature-256'] ?? '');
      request.resume();
      request.once('end', () => response.writeHead(202).end('accepted'));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
    const relay = new GithubWebhookSigningRelay(
      `http://127.0.0.1:${address.port}/hook`,
      secret,
    );
    const relayUrl = await relay.listen();

    const response = await fetch(relayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-1',
      },
      body: payload,
    });

    expect(response.status).toBe(202);
    expect(observedSignature).toBe(
      `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`,
    );
    await relay.close();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => error ? reject(error) : resolve());
    });
  });

  it('AC-WHRT-001 starts one child per enabled registration and stops changed or disabled children', () => {
    const store = new WebhookControlStore(tempRoot());
    const first = store.addRepository({
      repository: 'acme/one',
      enabled: true,
      events: ['issues'],
      consumers: ['agentops'],
      workspaceRoot: null,
      readyLabel: null,
      baseBranch: null,
    });
    store.addRepository({
      repository: 'acme/two',
      enabled: false,
      events: ['pull_request'],
      consumers: ['agentops'],
      workspaceRoot: null,
      readyLabel: null,
      baseBranch: null,
    });
    const starts: Array<{
      registration: WebhookRepositoryRegistration;
      hookUrl: string;
      process: FakeProcess;
    }> = [];
    const supervisor = new GithubWebhookForwarderSupervisor(store, {
      hookUrl: 'http://127.0.0.1:8377/hook',
      spawnForwarder: (registration, hookUrl) => {
        const process = new FakeProcess();
        starts.push({ registration, hookUrl, process });
        return process;
      },
    });

    supervisor.reconcile();
    expect(starts.map((row) => row.registration.repository)).toEqual(['acme/one']);
    expect(starts[0]!.hookUrl).toBe('http://127.0.0.1:8377/hook');

    store.updateRepository(first.id, { events: ['issues', 'pull_request'] });
    supervisor.reconcile();
    expect(starts).toHaveLength(2);
    expect(starts[0]!.process.killed).toEqual(['SIGTERM']);
    expect(starts[1]!.registration.events).toEqual(['issues', 'pull_request']);

    store.updateRepository(first.id, { enabled: false });
    supervisor.reconcile();
    expect(starts[1]!.process.killed).toEqual(['SIGTERM']);
    expect(supervisor.running.size).toBe(0);
  });

  it('AC-WHRT-002 restarts an unexpectedly exited child on the next reconciliation', () => {
    const store = new WebhookControlStore(tempRoot());
    store.addRepository({
      repository: 'acme/theme',
      enabled: true,
      events: ['pull_request'],
      consumers: ['agentops'],
      workspaceRoot: null,
      readyLabel: null,
      baseBranch: null,
    });
    const processes: FakeProcess[] = [];
    const supervisor = new GithubWebhookForwarderSupervisor(store, {
      hookUrl: 'http://127.0.0.1:8377/hook',
      spawnForwarder: () => {
        const process = new FakeProcess();
        processes.push(process);
        return process;
      },
    });

    supervisor.reconcile();
    processes[0]!.exit(1);
    expect(supervisor.running.size).toBe(0);
    supervisor.reconcile();

    expect(processes).toHaveLength(2);
    expect(supervisor.running.size).toBe(1);
  });

  it('PR-INTENT exposes disabled and failed forwarders with diagnostic timestamps', () => {
    const store = new WebhookControlStore(tempRoot());
    const enabled = store.addRepository({
      repository: 'acme/enabled',
      enabled: true,
      events: ['pull_request'],
      consumers: ['agentops'],
      workspaceRoot: null,
      readyLabel: null,
      baseBranch: null,
    });
    const disabled = store.addRepository({
      repository: 'acme/disabled',
      enabled: false,
      events: ['issues'],
      consumers: ['agentops'],
      workspaceRoot: null,
      readyLabel: null,
      baseBranch: null,
    });
    const process = new FakeProcess();
    const supervisor = new GithubWebhookForwarderSupervisor(store, {
      hookUrl: 'http://127.0.0.1:8377/hook',
      spawnForwarder: () => process,
    });

    supervisor.reconcile();
    process.emit('error', new Error('gh unavailable'));

    expect(supervisor.status()).toEqual([
      expect.objectContaining({
        registrationId: enabled.id,
        state: 'failed',
        error: 'gh unavailable',
        failedAt: expect.any(String),
      }),
      { registrationId: disabled.id, state: 'disabled' },
    ]);
  });
});
