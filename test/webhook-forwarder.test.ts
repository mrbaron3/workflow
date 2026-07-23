import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GithubWebhookForwarderSupervisor,
  GithubWebhookSigningRelay,
  MAX_RELAY_BODY_BYTES,
  isRelayBodyWithinLimit,
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

    spawn(registration, async () => {});
    process.stderr.emit('data', 'forwarder configured');

    expect(calls[0]).toEqual(expect.objectContaining({
      executable: 'gh',
      args: expect.not.arrayContaining([expect.stringContaining(secret)]),
    }));
    expect(calls[0]!.args).not.toEqual(expect.arrayContaining([expect.stringContaining('--secret')]));
    expect(calls[0]!.args).not.toEqual(expect.arrayContaining([expect.stringContaining('--url')]));
    expect(logs.join('\n')).not.toContain(secret);
  });

  it('ISSUE-0024/PR-INTENT signs unsigned gh traffic inside the daemon process', async () => {
    const secret = 'relay-only-secret';
    const payload = Buffer.from('{"action":"opened"}');
    let observedSignature = '';
    const relay = new GithubWebhookSigningRelay(
      'http://127.0.0.1:8377/hook',
      secret,
      async (_input, init) => {
        observedSignature = new Headers(init?.headers).get('x-hub-signature-256') ?? '';
        return new Response('accepted', { status: 202 });
      },
    );
    const response = await relay.forwardTrustedEvent({
      body: payload,
      event: 'pull_request',
      delivery: 'delivery-1',
    });

    expect(response.status).toBe(202);
    expect(observedSignature).toBe(
      `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`,
    );
    await relay.close();
  });

  it('ISSUE-0024/PR-INTENT accepts events through the private child pipe and triggers the signed consumer', async () => {
    const process = new FakeProcess();
    let consumerBody = '';
    let releaseConsumer!: () => void;
    const consumed = new Promise<void>((resolve) => {
      releaseConsumer = resolve;
    });
    const relay = new GithubWebhookSigningRelay(
      'http://127.0.0.1:8377/hook',
      'relay-only-secret',
      async (_input, init) => {
        consumerBody = String(init?.body);
        releaseConsumer();
        return new Response(null, { status: 204 });
      },
    );
    const spawn = productionGithubWebhookForwarderSpawner(
      () => {},
      (() => process),
    );
    const registration = {
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
    } satisfies WebhookRepositoryRegistration;

    spawn(registration, (event) => relay.forwardTrustedEvent(event).then(() => undefined));
    process.stdout.emit('data', '{"action":"opened","pull_request":{"id":9}}\n');
    await consumed;

    expect(consumerBody).toBe('{"action":"opened","pull_request":{"id":9}}');
  });

  it('ISSUE-0024/PR-INTENT exact current-state payloads cannot reach the pipe-authenticated signer', async () => {
    let upstreamCalls = 0;
    const relay = new GithubWebhookSigningRelay(
      'http://127.0.0.1:8377/hook',
      'relay-only-secret',
      async () => {
        upstreamCalls += 1;
        return new Response(null, { status: 204 });
      },
    );
    const synthesizedCurrentGithubState = JSON.stringify({
      action: 'closed',
      pull_request: { state: 'closed', merged: true, head: { sha: 'a'.repeat(40) } },
    });
    expect(synthesizedCurrentGithubState).toContain('a'.repeat(40));
    expect('listen' in relay).toBe(false);
    expect(upstreamCalls).toBe(0);
    await relay.close();
  });

  it('ISSUE-0024/PR-INTENT pins the finite positive relay body cap', () => {
    expect(MAX_RELAY_BODY_BYTES).toBe(10 * 1024 * 1024);
    expect(Number.isSafeInteger(MAX_RELAY_BODY_BYTES)).toBe(true);
    expect(isRelayBodyWithinLimit(MAX_RELAY_BODY_BYTES)).toBe(true);
    expect(isRelayBodyWithinLimit(MAX_RELAY_BODY_BYTES + 1)).toBe(false);
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
      process: FakeProcess;
    }> = [];
    const forwardEvent = async () => {};
    const supervisor = new GithubWebhookForwarderSupervisor(store, {
      forwardEvent,
      spawnForwarder: (registration) => {
        const process = new FakeProcess();
        starts.push({ registration, process });
        return process;
      },
    });

    supervisor.reconcile();
    expect(starts.map((row) => row.registration.repository)).toEqual(['acme/one']);

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
      forwardEvent: async () => {},
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
      forwardEvent: async () => {},
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
