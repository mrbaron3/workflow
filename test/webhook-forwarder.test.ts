import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GithubWebhookForwarderSupervisor,
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
  it('starts one child per enabled registration and stops changed or disabled children', () => {
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

  it('restarts an unexpectedly exited child on the next reconciliation', () => {
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
});
