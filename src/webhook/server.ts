import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';
import { WebhookRouter, type WebhookConsumerHandlers } from './router.js';
import { WebhookControlStore } from './store.js';
import { webhookControlHtml } from './ui.js';

export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024 * 2;
export const DEFAULT_WEBHOOK_CONTROL_PORT = 8377;
export const WEBHOOK_GUI_LAUNCH_TTL_MS = 60_000;
const GUI_SESSION_COOKIE = 'agentops_webhook_session';

export interface WebhookControlServerOptions {
  root?: string;
  store?: WebhookControlStore;
  host?: string;
  port?: number;
  consumers?: WebhookConsumerHandlers;
  runtimeState?: () => unknown;
  log?: (message: string) => void;
  controlToken?: string;
  webhookSecret?: string;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function publicState(
  store: WebhookControlStore,
  runtimeState?: () => unknown,
): unknown {
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

function unauthorized(message: string): Error {
  const error = new Error(message);
  error.name = 'Unauthorized';
  return error;
}

function securelyEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function assertControlRequest(
  request: IncomingMessage,
  controlToken: string,
  browserSessions: ReadonlySet<string>,
  requireJson = false,
): void {
  const authorization = request.headers.authorization;
  const bearerAuthenticated = typeof authorization === 'string'
    && authorization.startsWith('Bearer ')
    && securelyEqual(authorization.slice('Bearer '.length), controlToken);
  const cookieHeader = request.headers.cookie ?? '';
  const browserAuthenticated = cookieHeader.split(';').some((part) => {
    const [name, ...value] = part.trim().split('=');
    return name === GUI_SESSION_COOKIE && browserSessions.has(value.join('='));
  });
  if (!bearerAuthenticated && !browserAuthenticated) {
    throw unauthorized('valid bearer authentication is required');
  }
  if (!requireJson) return;
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

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_WEBHOOK_BODY_BYTES) throw new Error('request body is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseJson(raw: Buffer): Record<string, unknown> {
  const parsed = JSON.parse(raw.length > 0 ? raw.toString('utf8') : '{}') as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return parseJson(await readRawBody(request));
}

function assertWebhookSignature(
  request: IncomingMessage,
  rawBody: Buffer,
  webhookSecret: string,
): void {
  const provided = request.headers['x-hub-signature-256'];
  if (typeof provided !== 'string') throw unauthorized('valid webhook signature is required');
  const expected = `sha256=${createHmac('sha256', webhookSecret).update(rawBody).digest('hex')}`;
  if (!securelyEqual(provided, expected)) throw unauthorized('valid webhook signature is required');
}

function headerMap(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    Object.entries(request.headers)
      .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
      .map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value]),
  );
}

export function createWebhookControlServer(options: WebhookControlServerOptions) {
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('webhook control plane is loopback-only; remote binding is not supported');
  }
  const port = options.port ?? DEFAULT_WEBHOOK_CONTROL_PORT;
  const effectiveControlToken = options.controlToken?.trim();
  const effectiveWebhookSecret = options.webhookSecret?.trim();
  if (!effectiveControlToken) throw new Error('non-empty controlToken is required');
  if (!effectiveWebhookSecret) throw new Error('non-empty webhookSecret is required');
  const log = options.log ?? (() => {});
  const store = options.store ?? new WebhookControlStore(options.root ?? process.cwd());
  const recovered = store.recoverInterruptedDeliveries();
  if (recovered > 0) log(`recovered ${recovered} interrupted webhook delivery(s)`);
  const router = new WebhookRouter(store, options.consumers ?? {});
  const launchTokens = new Map<string, number>();
  const browserSessions = new Set<string>();

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`);
    try {
      if (request.method === 'GET' && url.pathname === '/launch') {
        const token = url.searchParams.get('token') ?? '';
        const expiresAt = launchTokens.get(token);
        launchTokens.delete(token);
        if (!expiresAt || expiresAt < Date.now()) throw unauthorized('valid launch token is required');
        const session = randomBytes(32).toString('base64url');
        browserSessions.add(session);
        response.writeHead(303, {
          location: '/',
          'set-cookie': `${GUI_SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        });
        response.end();
        return;
      }
      if (request.method === 'GET' && url.pathname === '/') {
        assertControlRequest(request, effectiveControlToken, browserSessions);
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
        assertControlRequest(request, effectiveControlToken, browserSessions);
        sendJson(response, 200, publicState(store, options.runtimeState));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/repositories') {
        assertControlRequest(request, effectiveControlToken, browserSessions, true);
        const row = store.addRepository(await readJson(request));
        sendJson(response, 201, row);
        return;
      }
      const repositoryMatch = url.pathname.match(/^\/api\/repositories\/([^/]+)$/);
      if (request.method === 'PATCH' && repositoryMatch) {
        assertControlRequest(request, effectiveControlToken, browserSessions, true);
        const row = store.updateRepository(decodeURIComponent(repositoryMatch[1]!), await readJson(request));
        sendJson(response, 200, row);
        return;
      }
      const retryMatch = url.pathname.match(/^\/api\/deliveries\/([^/]+)\/retry$/);
      if (request.method === 'POST' && retryMatch) {
        assertControlRequest(request, effectiveControlToken, browserSessions, true);
        await readJson(request);
        const row = await router.retry(decodeURIComponent(retryMatch[1]!));
        sendJson(response, 200, row);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/hook') {
        const rawBody = await readRawBody(request);
        assertWebhookSignature(request, rawBody, effectiveWebhookSecret);
        const payload = parseJson(rawBody);
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
      const status = name === 'UnsupportedMediaType'
        ? 415
        : name === 'Forbidden'
          ? 403
          : name === 'Unauthorized'
            ? 401
            : 400;
      const message = error instanceof ZodError
        ? error.issues.map((issue) => {
          const field = issue.path.join('.') || 'input';
          if (issue.code === 'too_small' && (field === 'events' || field === 'consumers')) {
            return `${field} must include at least one selection`;
          }
          return `${field}: ${issue.message}`;
        }).join('; ')
        : error instanceof Error ? error.message : String(error);
      sendJson(response, status, { error: message });
    }
  });

  return {
    server,
    store,
    router,
    createLaunchUrl(baseUrl: string): string {
      const token = randomBytes(32).toString('base64url');
      launchTokens.set(token, Date.now() + WEBHOOK_GUI_LAUNCH_TTL_MS);
      const launchUrl = new URL('/launch', baseUrl);
      launchUrl.searchParams.set('token', token);
      return launchUrl.toString();
    },
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
