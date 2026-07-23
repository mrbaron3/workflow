import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, saveConfig } from '../src/config.js';
import { createWebhookConsumerAdapters } from '../src/webhook/consumers.js';
import { NormalizedGithubEvent } from '../src/webhook/schema.js';
import { WebhookControlStore } from '../src/webhook/store.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-consumer-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('allow-listed webhook consumer adapters', () => {
  it('wakes agentops with the fixed launcher in the registration workspace', async () => {
    const root = tempRoot();
    const workspace = path.join(root, 'repo-workspace');
    fs.mkdirSync(workspace);
    saveConfig(workspace, {
      ...DEFAULT_CONFIG,
      intake: { backend: 'github', repository: 'acme/theme' },
    });
    const store = new WebhookControlStore(root);
    const registration = store.addRepository({
      repository: 'acme/theme',
      enabled: true,
      events: ['issues'],
      consumers: ['agentops'],
      workspaceRoot: workspace,
      readyLabel: 'ready',
      baseBranch: 'main',
    });
    const calls: Array<{ executable: string; args: string[]; cwd: string }> = [];
    const adapters = createWebhookConsumerAdapters(store, {
      harnessRoot: root,
      runProcess: async (executable, args, options) => {
        calls.push({ executable, args, cwd: options.cwd });
      },
    });
    const event = NormalizedGithubEvent.parse({
      deliveryId: 'WHDEL-0001',
      deliveryKey: 'delivery-1',
      registrationId: registration.id,
      repository: 'acme/theme',
      event: 'issues',
      action: 'labeled',
      payload: { repository: { full_name: 'acme/theme' } },
      receivedAt: new Date().toISOString(),
    });

    await adapters.agentops!(event);

    expect(calls).toEqual([{
      executable: process.execPath,
      args: [path.join(root, 'bin', 'agentops.mjs'), 'github-turn'],
      cwd: workspace,
    }]);
  });

  it('maps merged PR and push payloads to the typed Orca sync adapter', async () => {
    const root = tempRoot();
    const store = new WebhookControlStore(root);
    const registration = store.addRepository({
      repository: 'acme/theme',
      enabled: true,
      events: ['pull_request', 'push'],
      consumers: ['orca-worktree-sync'],
      workspaceRoot: null,
      readyLabel: null,
      baseBranch: null,
    });
    const calls: string[][] = [];
    const adapters = createWebhookConsumerAdapters(store, {
      harnessRoot: root,
      orcaSyncScript: '/portable/orca-sync-worktrees.py',
      runProcess: async (executable, args) => { calls.push([executable, ...args]); },
    });
    const common = {
      deliveryId: 'WHDEL-0001',
      deliveryKey: 'delivery-1',
      registrationId: registration.id,
      repository: 'acme/theme',
      receivedAt: new Date().toISOString(),
    };

    await adapters['orca-worktree-sync']!(NormalizedGithubEvent.parse({
      ...common,
      event: 'pull_request',
      action: 'closed',
      payload: {
        repository: { full_name: 'acme/theme' },
        pull_request: {
          merged: true,
          head: { ref: 'feature/webhooks' },
          base: { ref: 'main' },
        },
      },
    }));
    await adapters['orca-worktree-sync']!(NormalizedGithubEvent.parse({
      ...common,
      deliveryId: 'WHDEL-0002',
      deliveryKey: 'delivery-2',
      event: 'push',
      action: null,
      payload: {
        repository: { full_name: 'acme/theme' },
        ref: 'refs/heads/main',
        deleted: false,
      },
    }));

    expect(calls).toEqual([
      ['/portable/orca-sync-worktrees.py', '--event', 'pr-merged', '--head', 'feature/webhooks', '--base', 'main'],
      ['/portable/orca-sync-worktrees.py', '--event', 'push', '--branch', 'main'],
    ]);
  });
});
