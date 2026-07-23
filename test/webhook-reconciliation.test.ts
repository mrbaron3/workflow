import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WebhookReconciliationScheduler,
} from '../src/webhook/reconciliation.js';
import type { NormalizedGithubEvent } from '../src/webhook/schema.js';
import { WebhookControlStore } from '../src/webhook/store.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('webhook polling reconciliation fallback', () => {
  it('wakes each enabled AgentOps registration through the normalized consumer seam', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-reconcile-'));
    roots.push(root);
    const store = new WebhookControlStore(root);
    const enabled = store.addRepository({
      repository: 'acme/one',
      enabled: true,
      events: ['pull_request'],
      consumers: ['agentops'],
      workspaceRoot: null,
      readyLabel: null,
      baseBranch: null,
    });
    store.addRepository({
      repository: 'acme/two',
      enabled: false,
      events: ['issues'],
      consumers: ['agentops'],
      workspaceRoot: null,
      readyLabel: null,
      baseBranch: null,
    });
    store.addRepository({
      repository: 'acme/three',
      enabled: true,
      events: ['push'],
      consumers: ['orca-worktree-sync'],
      workspaceRoot: null,
      readyLabel: null,
      baseBranch: null,
    });
    const calls: NormalizedGithubEvent[] = [];
    const scheduler = new WebhookReconciliationScheduler(
      store,
      (event) => { calls.push(event); },
    );

    await scheduler.tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      registrationId: enabled.id,
      repository: 'acme/one',
      action: 'reconcile',
      source: 'reconciliation',
    });
  });

  it('coalesces overlapping timer ticks instead of queueing duplicate development turns', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-reconcile-singleflight-'));
    roots.push(root);
    const store = new WebhookControlStore(root);
    store.addRepository({
      repository: 'acme/one',
      enabled: true,
      events: ['issues'],
      consumers: ['agentops'],
      workspaceRoot: null,
      readyLabel: null,
      baseBranch: null,
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const scheduler = new WebhookReconciliationScheduler(store, async () => {
      calls += 1;
      await blocked;
    });

    const first = scheduler.tick();
    const second = scheduler.tick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
    expect(second).toBe(first);

    release();
    await Promise.all([first, second]);
  });
});
