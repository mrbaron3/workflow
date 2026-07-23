import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWebhookControlServer,
  DEFAULT_WEBHOOK_CONTROL_PORT,
  MAX_WEBHOOK_BODY_BYTES,
  WEBHOOK_GUI_LAUNCH_TTL_MS,
} from '../src/webhook/server.js';
import { DEFAULT_FORWARDER_RECONCILE_INTERVAL_MS } from '../src/webhook/forwarder.js';
import { DEFAULT_WEBHOOK_RECONCILIATION_INTERVAL_MS } from '../src/webhook/reconciliation.js';
import type { WebhookConsumerHandlers } from '../src/webhook/router.js';
import {
  webhookControlHtml,
  WEBHOOK_UI_REFRESH_INTERVAL_MS,
  WEBHOOK_UI_VISIBLE_DELIVERY_LIMIT,
} from '../src/webhook/ui.js';

const roots: string[] = [];
const servers: Array<ReturnType<typeof createWebhookControlServer>> = [];
const CONTROL_TOKEN = 'control-secret';
const WEBHOOK_SECRET = 'webhook-secret';

async function request(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${CONTROL_TOKEN}`);
  if (String(input).endsWith('/hook') && typeof init.body === 'string' && !headers.has('x-hub-signature-256')) {
    headers.set('x-hub-signature-256', signature(WEBHOOK_SECRET, init.body));
  }
  return globalThis.fetch(input, { ...init, headers });
}

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
    controlToken: CONTROL_TOKEN,
    webhookSecret: WEBHOOK_SECRET,
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
  return request(`${url}/api/repositories`, {
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

function signature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`;
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('local webhook control server', () => {
  it('ISSUE-0024/PR-INTENT fails closed when either daemon credential is absent', () => {
    expect(() => createWebhookControlServer({
      root: tempRoot(),
      controlToken: 'control-secret',
    })).toThrow('webhookSecret');
    expect(() => createWebhookControlServer({
      root: tempRoot(),
      webhookSecret: 'webhook-secret',
    })).toThrow('controlToken');
    expect(() => createWebhookControlServer({ root: tempRoot() })).toThrow('controlToken');
  });

  it('AC-WHUI-001 serves the self-contained GUI and public state', async () => {
    const { url } = await start({ agentops: async () => {} });
    expect((await addRepository(url)).status).toBe(201);
    const hook = await request(`${url}/hook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-populated-state',
      },
      body: JSON.stringify({
        action: 'synchronize',
        repository: { full_name: 'acme/theme' },
      }),
    });
    expect(hook.status).toBe(202);
    await waitFor(async () => {
      const state = await json(await request(`${url}/api/state`));
      return (state.deliveries as Array<{ status: string }>)[0]?.status === 'processed';
    });

    const page = await request(url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('<h1>Webhook Control</h1>');
    expect(html).toContain("api('/api/state')");
    expect(html).toContain("reconcile(document.querySelector('#repositories'), state.repositories");
    expect(html).toContain('const deliveries=state.deliveries');

    const response = await request(`${url}/api/state`);
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      repositories: [
        expect.objectContaining({
          id: 'WHREPO-0001',
          repository: 'acme/theme',
          enabled: true,
          events: ['pull_request'],
          consumers: ['agentops'],
        }),
      ],
      deliveries: [
        expect.objectContaining({
          id: 'WHDEL-0001',
          deliveryKey: 'delivery-populated-state',
          repository: 'acme/theme',
          event: 'pull_request',
          action: 'synchronize',
          status: 'processed',
          attempts: 1,
          lastError: null,
          ignoredReason: null,
        }),
      ],
    });
  });

  it('ISSUE-0024/PR-INTENT bootstraps a browser session and authenticates GUI API requests end to end', async () => {
    const { url, control } = await start();
    const launchUrl = control.createLaunchUrl(url);
    const launched = await globalThis.fetch(launchUrl, { redirect: 'manual' });

    expect(launched.status).toBe(303);
    expect(launched.headers.get('location')).toBe('/');
    const cookie = launched.headers.get('set-cookie');
    expect(cookie).toContain('agentops_webhook_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(launchUrl).not.toContain(CONTROL_TOKEN);

    const page = await globalThis.fetch(url, { headers: { cookie: cookie!.split(';')[0]! } });
    expect(page.status).toBe(200);
    const state = await globalThis.fetch(`${url}/api/state`, {
      headers: { cookie: cookie!.split(';')[0]! },
    });
    expect(state.status).toBe(200);
    expect(await json(state)).toEqual({ repositories: [], deliveries: [] });
    expect((await globalThis.fetch(launchUrl, { redirect: 'manual' })).status).toBe(401);
  });

  it('AC-WHUI-002 AC-WHUI-003 saves valid registrations and rejects duplicate or unknown values', async () => {
    const { url } = await start();

    const created = await addRepository(url);
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({ repository: 'acme/theme' });
    expect((await addRepository(url)).status).toBe(400);

    const invalid = await request(`${url}/api/repositories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repository: 'acme/theme-two',
        enabled: true,
        events: ['pull_request'],
        consumers: ['shell-command'],
      }),
    });
    expect(invalid.status).toBe(400);
    expect(String((await json(invalid)).error)).toContain('consumers');

    const invalidRepository = await request(`${url}/api/repositories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repository: 'not-a-repository',
        enabled: true,
        events: ['pull_request'],
        consumers: ['agentops'],
      }),
    });
    expect(invalidRepository.status).toBe(400);
    expect(String((await json(invalidRepository)).error)).toContain('repository');
  });

  it('PR-INTENT pins webhook operational constants', () => {
    expect(DEFAULT_WEBHOOK_CONTROL_PORT).toBe(8377);
    expect(DEFAULT_FORWARDER_RECONCILE_INTERVAL_MS).toBe(5_000);
    expect(DEFAULT_WEBHOOK_RECONCILIATION_INTERVAL_MS).toBe(30_000);
    expect(MAX_WEBHOOK_BODY_BYTES).toBe(2 * 1024 * 1024);
    expect(WEBHOOK_GUI_LAUNCH_TTL_MS).toBe(60_000);
    expect(WEBHOOK_UI_REFRESH_INTERVAL_MS).toBe(5_000);
    expect(WEBHOOK_UI_VISIBLE_DELIVERY_LIMIT).toBe(50);
  });

  it('PR-INTENT emits static accessibility labels and status regions', () => {
    const source = webhookControlHtml();

    expect(source).toContain('tabindex="0" role="region" aria-labelledby="deliveries-title"');
    expect(source).toContain('id="connection-announcement" role="status" aria-live="polite"');
    expect(source).toContain('id="last-updated" aria-live="off"');
    expect(source).toContain("class=\"action-status\" role=\"status\" aria-live=\"polite\"");
    expect(source).not.toContain('.operational-stale { opacity:');
    expect(source).toContain("const DEFAULT_EVENTS =");
    expect(source).toContain("const DEFAULT_CONSUMERS =");
  });

  it('AC-WHUI-004 exposes failures and retries them through the API', async () => {
    let fail = true;
    const { url } = await start({
      agentops: () => {
        if (fail) throw new Error('consumer offline');
      },
    });
    await addRepository(url);

    const hook = await request(`${url}/hook`, {
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
      const state = await json(await request(`${url}/api/state`));
      return (state.deliveries as Array<{ status: string }>)[0]?.status === 'failed';
    });

    fail = false;
    const retried = await request(`${url}/api/deliveries/${receipt.deliveryId}/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(retried.status).toBe(200);
    expect(await json(retried)).toMatchObject({ status: 'processed', attempts: 2 });
  });

  it('AC-WHUI-005 defaults to loopback and validates mutation origin and content type', async () => {
    const control = createWebhookControlServer({
      root: tempRoot(), port: 0, controlToken: CONTROL_TOKEN, webhookSecret: WEBHOOK_SECRET,
    });
    servers.push(control);
    const address = await control.listen();
    expect(address.host).toBe('127.0.0.1');

    const wrongType = await request(`${address.url}/api/repositories`, {
      method: 'POST',
      body: '{}',
    });
    expect(wrongType.status).toBe(415);

    const crossOrigin = await request(`${address.url}/api/repositories`, {
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
    const html = await (await request(url)).text();
    expect(html).not.toContain('name="command"');

    const created = await request(`${url}/api/repositories`, {
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

  it('PR-INTENT rejects every remotely reachable control-plane configuration', () => {
    expect(() => createWebhookControlServer({
      root: tempRoot(),
      host: '0.0.0.0',
      port: 0,
    })).toThrow('loopback-only');
  });

  it('PR-INTENT honors an explicitly supplied loopback control token', async () => {
    const control = createWebhookControlServer({
      root: tempRoot(),
      host: '127.0.0.1',
      port: 0,
      controlToken: 'control-secret',
      webhookSecret: WEBHOOK_SECRET,
    });
    servers.push(control);
    const { url } = await control.listen();

    expect((await globalThis.fetch(`${url}/api/state`)).status).toBe(401);
    expect((await request(`${url}/api/state`, {
      headers: { authorization: 'Bearer control-secret' },
    })).status).toBe(200);
    expect((await globalThis.fetch(url)).status).toBe(401);
    expect((await request(url, {
      headers: { authorization: 'Bearer control-secret' },
    })).status).toBe(200);

    const unauthenticated = await globalThis.fetch(`${url}/api/repositories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(unauthenticated.status).toBe(401);

    const authenticated = await request(`${url}/api/repositories`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer control-secret',
      },
      body: JSON.stringify({
        repository: 'acme/theme',
        enabled: true,
        events: ['pull_request'],
        consumers: ['agentops'],
      }),
    });
    expect(authenticated.status).toBe(201);
  });

  it('PR-INTENT verifies a configured webhook signature over exact raw bytes before persistence', async () => {
    const control = createWebhookControlServer({
      root: tempRoot(),
      host: '127.0.0.1',
      port: 0,
      webhookSecret: 'webhook-secret',
      controlToken: CONTROL_TOKEN,
    });
    servers.push(control);
    const { url } = await control.listen();
    const body = '{ "action": "opened", "repository": { "full_name": "acme/theme" } }';
    const headers = {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-github-delivery': 'signed-delivery',
    };

    const missing = await globalThis.fetch(`${url}/hook`, { method: 'POST', headers, body });
    expect(missing.status).toBe(401);
    expect(control.store.snapshot().deliveries).toHaveLength(0);

    const invalid = await request(`${url}/hook`, {
      method: 'POST',
      headers: { ...headers, 'x-hub-signature-256': signature('wrong-secret', body) },
      body,
    });
    expect(invalid.status).toBe(401);
    expect(control.store.snapshot().deliveries).toHaveLength(0);

    const valid = await request(`${url}/hook`, {
      method: 'POST',
      headers: { ...headers, 'x-hub-signature-256': signature('webhook-secret', body) },
      body,
    });
    expect(valid.status).toBe(202);
    expect(control.store.snapshot().deliveries).toHaveLength(1);
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

    expect((await request(`${url}/hook`, options)).status).toBe(202);
    await waitFor(async () => calls === 1);
    const duplicate = await request(`${url}/hook`, options);
    expect(duplicate.status).toBe(202);
    expect(await json(duplicate)).toMatchObject({ duplicate: true });
    expect(calls).toBe(1);
  });
});
