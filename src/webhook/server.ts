import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebhookRouter, type WebhookConsumerHandlers } from './router.js';
import { WebhookControlStore } from './store.js';
import { webhookControlHtml } from './ui.js';

const MAX_BODY_BYTES = 1024 * 1024 * 2;

export interface WebhookControlServerOptions {
  root?: string;
  store?: WebhookControlStore;
  host?: string;
  port?: number;
  consumers?: WebhookConsumerHandlers;
  runtimeState?: () => unknown;
  log?: (message: string) => void;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function publicState(store: WebhookControlStore, runtimeState?: () => unknown): unknown {
  const state = store.snapshot();
  return {
    repositories: state.repositories,
    deliveries: state.deliveries.map((row) => ({
      id: row.id,
      deliveryKey: row.deliveryKey,
      repository: row.repository,
      event: row.event,
      action: row.action,
      status: row.status,
      attempts: row.attempts,
      lastError: row.lastError,
      ignoredReason: row.ignoredReason,
      receivedAt: row.receivedAt,
      updatedAt: row.updatedAt,
    })),
    ...(runtimeState ? { runtime: runtimeState() } : {}),
  };
}

function assertMutationRequest(request: IncomingMessage): void {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    const error = new Error('mutation requests require application/json');
    error.name = 'UnsupportedMediaType';
    throw error;
  }
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin && host && origin !== `http://${host}` && origin !== `https://${host}`) {
    const error = new Error('cross-origin mutation rejected');
    error.name = 'Forbidden';
    throw error;
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const parsed = JSON.parse(raw || '{}') as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function headerMap(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    Object.entries(request.headers)
      .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
      .map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value]),
  );
}

export function createWebhookControlServer(options: WebhookControlServerOptions = {}) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8377;
  const log = options.log ?? (() => {});
  const store = options.store ?? new WebhookControlStore(options.root ?? process.cwd());
  const recovered = store.recoverInterruptedDeliveries();
  if (recovered > 0) log(`recovered ${recovered} interrupted webhook delivery(s)`);
  const router = new WebhookRouter(store, options.consumers ?? {});

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`);
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        });
        response.end(webhookControlHtml());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        sendJson(response, 200, publicState(store, options.runtimeState));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/repositories') {
        assertMutationRequest(request);
        const row = store.addRepository(await readJson(request));
        sendJson(response, 201, row);
        return;
      }
      const repositoryMatch = url.pathname.match(/^\/api\/repositories\/([^/]+)$/);
      if (request.method === 'PATCH' && repositoryMatch) {
        assertMutationRequest(request);
        const row = store.updateRepository(decodeURIComponent(repositoryMatch[1]!), await readJson(request));
        sendJson(response, 200, row);
        return;
      }
      const retryMatch = url.pathname.match(/^\/api\/deliveries\/([^/]+)\/retry$/);
      if (request.method === 'POST' && retryMatch) {
        assertMutationRequest(request);
        await readJson(request);
        const row = await router.retry(decodeURIComponent(retryMatch[1]!));
        sendJson(response, 200, row);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/hook') {
        const payload = await readJson(request);
        const event = request.headers['x-github-event'];
        const deliveryKey = request.headers['x-github-delivery'];
        if (typeof event !== 'string' || typeof deliveryKey !== 'string') {
          sendJson(response, 400, { error: 'X-GitHub-Event and X-GitHub-Delivery are required' });
          return;
        }
        const receipt = store.receiveDelivery({
          deliveryKey,
          event,
          headers: headerMap(request),
          payload,
        });
        // Persist-before-ack: receiveDelivery atomically saves before this response.
        sendJson(response, 202, receipt);
        if (!receipt.duplicate) {
          void router.route(receipt.deliveryId).then(
            (row) => log(`webhook ${row.id} ${row.repository} ${row.event} → ${row.status}`),
            (error) => log(`webhook ${receipt.deliveryId} route failed: ${String(error)}`),
          );
        }
        return;
      }
      sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const status = name === 'UnsupportedMediaType' ? 415 : name === 'Forbidden' ? 403 : 400;
      sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  return {
    server,
    store,
    router,
    async listen(): Promise<{ host: string; port: number; url: string }> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address() as AddressInfo;
      return { host, port: address.port, url: `http://${host}:${address.port}` };
    },
    async close(): Promise<void> {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
