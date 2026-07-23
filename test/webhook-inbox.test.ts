import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NormalizedGithubEvent } from '../src/webhook/schema.js';
import { WebhookRouter } from '../src/webhook/router.js';
import { WebhookControlStore } from '../src/webhook/store.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-webhook-'));
  roots.push(root);
  return root;
}

function payload(repository = 'Acme/Theme', action = 'opened'): Record<string, unknown> {
  return {
    action,
    repository: { full_name: repository },
    pull_request: { number: 42 },
  };
}

function register(store: WebhookControlStore): void {
  store.addRepository({
    repository: 'acme/theme',
    enabled: true,
    events: ['pull_request'],
    consumers: ['agentops'],
    workspaceRoot: null,
    readyLabel: null,
    baseBranch: null,
  });
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('durable GitHub webhook inbox and router', () => {
  it('AC-WHIN-001/006 persists before returning a receipt and does not mutate db.json', () => {
    const root = tempRoot();
    const harnessDir = path.join(root, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });
    const dbPath = path.join(harnessDir, 'db.json');
    fs.writeFileSync(dbPath, '{"sentinel":true}\n');
    const store = new WebhookControlStore(root);

    const receipt = store.receiveDelivery({
      deliveryKey: 'delivery-1',
      event: 'pull_request',
      headers: { 'x-github-delivery': 'delivery-1' },
      payload: payload(),
    });

    expect(receipt).toMatchObject({ duplicate: false, status: 'pending' });
    expect(fs.existsSync(store.file)).toBe(true);
    expect(new WebhookControlStore(root).getDelivery(receipt.deliveryId)?.payload).toEqual(payload());
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('{"sentinel":true}\n');
  });

  it('AC-WHIN-001 surfaces persistence failures instead of returning an accepted receipt', () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, '.harness'), 'not a directory');
    const store = new WebhookControlStore(root);

    expect(() => store.receiveDelivery({
      deliveryKey: 'delivery-write-failure',
      event: 'pull_request',
      headers: {},
      payload: payload(),
    })).toThrow();
  });

  it('AC-WHIN-002 deduplicates a delivery key and invokes its consumer once', async () => {
    const store = new WebhookControlStore(tempRoot());
    register(store);
    const calls: NormalizedGithubEvent[] = [];
    const router = new WebhookRouter(store, {
      agentops: (event) => { calls.push(event); },
    });
    const input = {
      deliveryKey: 'delivery-duplicate',
      event: 'pull_request',
      headers: {},
      payload: payload(),
    };

    const first = store.receiveDelivery(input);
    await router.route(first.deliveryId);
    const second = store.receiveDelivery(input);
    await router.route(second.deliveryId);

    expect(second).toEqual({
      deliveryId: first.deliveryId,
      duplicate: true,
      status: 'processed',
    });
    expect(store.snapshot().deliveries).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('AC-WHIN-003 ignores unregistered repositories and events without calling consumers', async () => {
    const store = new WebhookControlStore(tempRoot());
    register(store);
    let calls = 0;
    const router = new WebhookRouter(store, {
      agentops: () => { calls += 1; },
    });

    const unknown = store.receiveDelivery({
      deliveryKey: 'delivery-unknown',
      event: 'pull_request',
      headers: {},
      payload: payload('acme/unknown'),
    });
    const disabledEvent = store.receiveDelivery({
      deliveryKey: 'delivery-disabled-event',
      event: 'push',
      headers: {},
      payload: payload('acme/theme'),
    });

    expect((await router.route(unknown.deliveryId)).status).toBe('ignored');
    expect((await router.route(disabledEvent.deliveryId)).status).toBe('ignored');
    expect(store.getDelivery(unknown.deliveryId)?.ignoredReason).toContain('not registered');
    expect(store.getDelivery(disabledEvent.deliveryId)?.ignoredReason).toContain('not enabled');
    expect(calls).toBe(0);
  });

  it('AC-WHIN-004 routes a normalized event to every configured consumer', async () => {
    const store = new WebhookControlStore(tempRoot());
    store.addRepository({
      repository: 'acme/theme',
      enabled: true,
      events: ['pull_request'],
      consumers: ['agentops', 'orca-worktree-sync'],
      workspaceRoot: '/work/acme-theme',
      readyLabel: 'ready',
      baseBranch: 'main',
    });
    const calls: Array<[string, NormalizedGithubEvent]> = [];
    const router = new WebhookRouter(store, {
      agentops: (event) => { calls.push(['agentops', event]); },
      'orca-worktree-sync': (event) => { calls.push(['orca', event]); },
    });
    const receipt = store.receiveDelivery({
      deliveryKey: 'delivery-routed',
      event: 'pull_request',
      headers: {},
      payload: payload(),
    });

    const result = await router.route(receipt.deliveryId);

    expect(result.status).toBe('processed');
    expect(calls.map(([consumer]) => consumer)).toEqual(['agentops', 'orca']);
    expect(calls[0]![1]).toMatchObject({
      deliveryId: receipt.deliveryId,
      deliveryKey: 'delivery-routed',
      repository: 'acme/theme',
      event: 'pull_request',
      action: 'opened',
      source: 'webhook',
    });
  });

  it('AC-WHIN-005 retains a failed payload and retries it', async () => {
    const store = new WebhookControlStore(tempRoot());
    register(store);
    let fail = true;
    let calls = 0;
    const router = new WebhookRouter(store, {
      agentops: () => {
        calls += 1;
        if (fail) throw new Error('temporary consumer failure');
      },
    });
    const receipt = store.receiveDelivery({
      deliveryKey: 'delivery-retry',
      event: 'pull_request',
      headers: {},
      payload: payload(),
    });

    const failed = await router.route(receipt.deliveryId);
    expect(failed).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'temporary consumer failure',
      payload: payload(),
    });

    fail = false;
    const processed = await router.retry(receipt.deliveryId);
    expect(processed).toMatchObject({
      status: 'processed',
      attempts: 2,
      lastError: null,
      payload: payload(),
    });
    expect(calls).toBe(2);
  });

  it('recovers a delivery interrupted while processing after daemon restart', () => {
    const root = tempRoot();
    const store = new WebhookControlStore(root);
    register(store);
    const receipt = store.receiveDelivery({
      deliveryKey: 'delivery-interrupted',
      event: 'pull_request',
      headers: {},
      payload: payload(),
    });
    const registration = store.snapshot().repositories[0]!;
    store.startDelivery(receipt.deliveryId, registration.id);

    const restarted = new WebhookControlStore(root);
    expect(restarted.recoverInterruptedDeliveries()).toBe(1);
    expect(restarted.getDelivery(receipt.deliveryId)).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'delivery processing was interrupted; recovered on daemon start',
    });
  });
});
