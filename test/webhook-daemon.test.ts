import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_TIMER_DELAY_MS,
  parseWebhookDaemonOptions,
  waitForWebhookDaemonShutdown,
} from '../src/webhook/daemon.js';

const credentials = {
  AGENTOPS_WEBHOOK_CONTROL_TOKEN: ' control-token ',
  AGENTOPS_GITHUB_WEBHOOK_SECRET: ' webhook-secret ',
};
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('webhook-daemon command boundary', () => {
  it('ISSUE-0024/PR-INTENT starts and stops through the real CLI dispatch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-daemon-cli-'));
    roots.push(root);
    const launcher = path.resolve(import.meta.dirname, '..', 'bin', 'agentops.mjs');
    const child = spawn(process.execPath, [
      launcher,
      'webhook-daemon',
      '--host', '127.0.0.1',
      '--port', '0',
      '--no-forward',
      '--no-reconcile',
    ], {
      cwd: root,
      env: {
        ...process.env,
        NO_COLOR: '1',
        AGENTOPS_WEBHOOK_CONTROL_TOKEN: 'control-token',
        AGENTOPS_GITHUB_WEBHOOK_SECRET: 'webhook-secret',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let output = '';
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`daemon startup timed out\n${output}`)), 10_000);
      const inspect = (chunk: Buffer | string) => {
        output += String(chunk);
        const match = output.match(/webhook control listening (http:\/\/127\.0\.0\.1:\d+)/);
        if (!match) return;
        clearTimeout(timer);
        resolve(match[1]!);
      };
      child.stdout!.on('data', inspect);
      child.stderr!.on('data', inspect);
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== null && !output.includes('webhook control listening')) {
          reject(new Error(`daemon exited during startup (${code})\n${output}`));
        }
      });
    });

    const headers = { authorization: 'Bearer control-token' };
    const state = await fetch(`${url}/api/state`, { headers });
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({
      repositories: [],
      deliveries: [],
      runtime: { forwarders: [] },
    });
    const page = await fetch(url, { headers });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Repositoryを追加');
    expect(output).toContain('GitHub forwarders disabled');
    expect(output).toContain('polling reconciliation disabled');

    child.kill('SIGTERM');
    const exit = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(exit).toBe(0);
    expect(fs.existsSync(path.join(root, '.harness', 'webhooks.json'))).toBe(true);
  }, 15_000);

  it('ISSUE-0024/PR-INTENT parses flags and propagates trimmed credentials', () => {
    expect(parseWebhookDaemonOptions({
      host: '::1',
      port: '0',
      'reconcile-interval-ms': '1234',
      'orca-sync-script': './sync.py',
      'no-forward': true,
      'no-reconcile': true,
      open: true,
    }, credentials)).toEqual({
      host: '::1',
      port: 0,
      reconciliationIntervalMs: 1234,
      controlToken: 'control-token',
      webhookSecret: 'webhook-secret',
      orcaSyncScript: './sync.py',
      forward: false,
      reconcile: false,
      open: true,
    });
  });

  it.each([
    [{ host: '0.0.0.0' }, /loopback-only/],
    [{ port: '-1' }, /--port/],
    [{ port: '65536' }, /--port/],
    [{ port: '1.5' }, /--port/],
    [{ 'reconcile-interval-ms': '0' }, /reconcile-interval-ms/],
    [{ 'reconcile-interval-ms': String(MAX_TIMER_DELAY_MS + 1) }, /reconcile-interval-ms/],
  ])('ISSUE-0024/PR-INTENT rejects invalid daemon option %j', (flags, message) => {
    expect(() => parseWebhookDaemonOptions(flags, credentials)).toThrow(message);
  });

  it('ISSUE-0024/PR-INTENT accepts and pins the maximum timer-safe delay', () => {
    expect(MAX_TIMER_DELAY_MS).toBe(2_147_483_647);
    expect(parseWebhookDaemonOptions({
      'reconcile-interval-ms': String(MAX_TIMER_DELAY_MS),
    }, credentials).reconciliationIntervalMs).toBe(MAX_TIMER_DELAY_MS);
  });

  it('ISSUE-0024/PR-INTENT fails closed when either credential is missing', () => {
    expect(() => parseWebhookDaemonOptions({}, {
      AGENTOPS_GITHUB_WEBHOOK_SECRET: 'secret',
    })).toThrow('CONTROL_TOKEN');
    expect(() => parseWebhookDaemonOptions({}, {
      AGENTOPS_WEBHOOK_CONTROL_TOKEN: 'token',
    })).toThrow('WEBHOOK_SECRET');
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'ISSUE-0024/PR-INTENT %s stops reconciliation, forwarders, and server exactly once',
    async (signal) => {
      const signals = new EventEmitter();
      const reconciliation = { stop: vi.fn() };
      const forwarders = { stop: vi.fn() };
      const signingRelay = { close: vi.fn(async () => {}) };
      const control = { close: vi.fn(async () => {}) };
      const stopped = waitForWebhookDaemonShutdown(
        { reconciliation, forwarders, signingRelay, control },
        signals,
      );
      signals.emit(signal);
      signals.emit(signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT');
      await stopped;
      expect(reconciliation.stop).toHaveBeenCalledTimes(1);
      expect(forwarders.stop).toHaveBeenCalledTimes(1);
      expect(signingRelay.close).toHaveBeenCalledTimes(1);
      expect(control.close).toHaveBeenCalledTimes(1);
      expect(signals.listenerCount('SIGINT')).toBe(0);
      expect(signals.listenerCount('SIGTERM')).toBe(0);
    },
  );
});
