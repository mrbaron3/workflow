import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, saveConfig } from '../src/config.js';
import {
  createWebhookConsumerAdapters,
  sanitizedConsumerEnvironment,
} from '../src/webhook/consumers.js';
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
  it('ISSUE-0024/PR-INTENT preserves GitHub authentication but strips daemon credentials', () => {
    const env = sanitizedConsumerEnvironment({
      PATH: '/bin',
      HOME: '/safe/home',
      GH_CONFIG_DIR: '/safe/gh',
      GH_TOKEN: 'github-token',
      SSH_AUTH_SOCK: '/safe/ssh-agent',
      AGENTOPS_WEBHOOK_CONTROL_TOKEN: 'control-secret',
      AGENTOPS_GITHUB_WEBHOOK_SECRET: 'webhook-secret',
    });

    expect(env).toMatchObject({
      PATH: '/bin',
      HOME: '/safe/home',
      GH_CONFIG_DIR: '/safe/gh',
      GH_TOKEN: 'github-token',
      SSH_AUTH_SOCK: '/safe/ssh-agent',
    });
    expect(env).not.toHaveProperty('AGENTOPS_WEBHOOK_CONTROL_TOKEN');
    expect(env).not.toHaveProperty('AGENTOPS_GITHUB_WEBHOOK_SECRET');
  });
  it('AC-WHRT-003 wakes agentops with the fixed launcher in the registration workspace', async () => {
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
    const calls: Array<{ executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
    const adapters = createWebhookConsumerAdapters(store, {
      harnessRoot: root,
      launcher: '/installed-agentops/bin/agentops.mjs',
      runProcess: async (executable, args, options) => {
        calls.push({ executable, args, cwd: options.cwd, env: options.env });
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
      args: ['/installed-agentops/bin/agentops.mjs', 'github-turn'],
      cwd: workspace,
      env: expect.not.objectContaining({
        AGENTOPS_WEBHOOK_CONTROL_TOKEN: expect.anything(),
        AGENTOPS_GITHUB_WEBHOOK_SECRET: expect.anything(),
      }),
    }]);
  });

  it('PR-INTENT aborts the active consumer and does not start queued work during shutdown', async () => {
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
    const controller = new AbortController();
    const calls: AbortSignal[] = [];
    const adapters = createWebhookConsumerAdapters(store, {
      harnessRoot: root,
      signal: controller.signal,
      runProcess: async (_executable, _args, options) => {
        calls.push(options.signal!);
        await new Promise<void>((_resolve, reject) => {
          options.signal!.addEventListener(
            'abort',
            () => reject(new Error('aborted by test')),
            { once: true },
          );
        });
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

    const active = adapters.agentops!(event);
    await new Promise((resolve) => setImmediate(resolve));
    const queued = adapters.agentops!({
      ...event,
      deliveryId: 'WHDEL-0002',
      deliveryKey: 'delivery-2',
    });
    controller.abort();

    await expect(active).rejects.toThrow('aborted by test');
    await expect(queued).rejects.toThrow('webhook consumer stopped');
    expect(calls).toEqual([controller.signal]);
    expect(calls[0]!.aborted).toBe(true);
  });

  it('AC-WHRT-004 maps merged PR and push payloads to the typed Orca sync adapter', async () => {
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
    const calls: Array<{ command: string[]; env: NodeJS.ProcessEnv }> = [];
    const adapters = createWebhookConsumerAdapters(store, {
      harnessRoot: root,
      orcaSyncScript: '/portable/orca-sync-worktrees.py',
      runProcess: async (executable, args, options) => {
        calls.push({ command: [executable, ...args], env: options.env });
      },
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

    expect(calls.map((call) => call.command)).toEqual([
      ['/portable/orca-sync-worktrees.py', '--event', 'pr-merged', '--head', 'feature/webhooks', '--base', 'main'],
      ['/portable/orca-sync-worktrees.py', '--event', 'push', '--branch', 'main'],
    ]);
    expect(calls.every(({ env }) =>
      !('AGENTOPS_WEBHOOK_CONTROL_TOKEN' in env)
      && !('AGENTOPS_GITHUB_WEBHOOK_SECRET' in env))).toBe(true);
  });
});
