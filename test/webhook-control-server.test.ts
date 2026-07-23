import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebhookControlServer } from '../src/webhook/server.js';
import type { WebhookConsumerHandlers } from '../src/webhook/router.js';

const roots: string[] = [];
const servers: Array<ReturnType<typeof createWebhookControlServer>> = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-webhook-server-'));
  roots.push(root);
  return root;
}

async function start(consumers: WebhookConsumerHandlers = {}) {
  const control = createWebhookControlServer({
    root: tempRoot(),
    host: '127.0.0.1',
    port: 0,
    consumers,
  });
  servers.push(control);
  return { control, ...(await control.listen()) };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for webhook state');
}

async function addRepository(url: string): Promise<Response> {
  return fetch(`${url}/api/repositories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      repository: 'acme/theme',
      enabled: true,
      events: ['pull_request'],
      consumers: ['agentops'],
      workspaceRoot: null,
      readyLabel: null,
      baseBranch: null,
    }),
  });
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('local webhook control server', () => {
  it('AC-WHUI-001 serves the self-contained GUI and public state', async () => {
    const { url } = await start();

    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('<h1>Webhook Control</h1>');

    const response = await fetch(`${url}/api/state`);
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ repositories: [], deliveries: [] });
  });

  it('AC-WHUI-002/003 saves valid registrations and rejects duplicate or unknown values', async () => {
    const { url } = await start();

    const created = await addRepository(url);
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({ repository: 'acme/theme' });
    expect((await addRepository(url)).status).toBe(400);

    const invalid = await fetch(`${url}/api/repositories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repository: 'not-a-repository',
        enabled: true,
        events: ['pull_request'],
        consumers: ['shell-command'],
      }),
    });
    expect(invalid.status).toBe(400);
  });

  it('AC-WHUI-004 exposes failures and retries them through the API', async () => {
    let fail = true;
    const { url } = await start({
      agentops: () => {
        if (fail) throw new Error('consumer offline');
      },
    });
    await addRepository(url);

    const hook = await fetch(`${url}/hook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-api-retry',
      },
      body: JSON.stringify({
        action: 'synchronize',
        repository: { full_name: 'acme/theme' },
      }),
    });
    expect(hook.status).toBe(202);
    const receipt = await json(hook);

    await waitFor(async () => {
      const state = await json(await fetch(`${url}/api/state`));
      return (state.deliveries as Array<{ status: string }>)[0]?.status === 'failed';
    });

    fail = false;
    const retried = await fetch(`${url}/api/deliveries/${receipt.deliveryId}/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(retried.status).toBe(200);
    expect(await json(retried)).toMatchObject({ status: 'processed', attempts: 2 });
  });

  it('AC-WHUI-005 defaults to loopback and validates mutation origin and content type', async () => {
    const control = createWebhookControlServer({ root: tempRoot(), port: 0 });
    servers.push(control);
    const address = await control.listen();
    expect(address.host).toBe('127.0.0.1');

    const wrongType = await fetch(`${address.url}/api/repositories`, {
      method: 'POST',
      body: '{}',
    });
    expect(wrongType.status).toBe(415);

    const crossOrigin = await fetch(`${address.url}/api/repositories`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://example.test',
      },
      body: '{}',
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('AC-WHUI-006 does not expose or persist arbitrary command fields', async () => {
    const { url, control } = await start();
    const html = await (await fetch(url)).text();
    expect(html).not.toContain('name="command"');

    const created = await fetch(`${url}/api/repositories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repository: 'acme/theme',
        enabled: true,
        events: ['pull_request'],
        consumers: ['agentops'],
        workspaceRoot: null,
        readyLabel: null,
        baseBranch: null,
        command: 'rm -rf /',
      }),
    });
    expect(created.status).toBe(201);
    expect(control.store.snapshot().repositories[0]).not.toHaveProperty('command');
  });

  it('deduplicates repeated GitHub deliveries before consumer dispatch', async () => {
    let calls = 0;
    const { url } = await start({ agentops: () => { calls += 1; } });
    await addRepository(url);
    const options = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-server-duplicate',
      },
      body: JSON.stringify({
        action: 'opened',
        repository: { full_name: 'acme/theme' },
      }),
    };

    expect((await fetch(`${url}/hook`, options)).status).toBe(202);
    await waitFor(async () => calls === 1);
    const duplicate = await fetch(`${url}/hook`, options);
    expect(duplicate.status).toBe(202);
    expect(await json(duplicate)).toMatchObject({ duplicate: true });
    expect(calls).toBe(1);
  });
});
