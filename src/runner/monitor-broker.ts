import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { PostgresControlStore } from '../control-store/store.js';
import type { MonitorBrokerRequest } from '../control-store/types.js';

const GitHubRow = z.object({
  number: z.number().int().positive(),
  updated_at: z.string().datetime({ offset: true }),
  pull_request: z.unknown().optional(),
}).passthrough();
const execFileAsync = promisify(execFile);

interface BrokerStore {
  claimMonitorBrokerRequest(
    input: Parameters<PostgresControlStore['claimMonitorBrokerRequest']>[0],
  ): ReturnType<PostgresControlStore['claimMonitorBrokerRequest']>;
  completeMonitorBrokerRequest(
    input: Parameters<PostgresControlStore['completeMonitorBrokerRequest']>[0],
  ): ReturnType<PostgresControlStore['completeMonitorBrokerRequest']>;
  failMonitorBrokerRequest(
    input: Parameters<PostgresControlStore['failMonitorBrokerRequest']>[0],
  ): ReturnType<PostgresControlStore['failMonitorBrokerRequest']>;
}

export interface PrivateMonitorBrokerOptions {
  store: BrokerStore;
  workerId: string;
  repository: string;
  githubToken: string;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  maxPages?: number;
  log?: (message: string) => void;
}

class MonitorBrokerFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
    if (match?.[2] === 'next') return match[1] ?? null;
  }
  return null;
}

async function readLimitedBody(
  response: Response,
  remainingBytes: number,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > remainingBytes) {
      await reader.cancel();
      throw new MonitorBrokerFailure(
        'response_too_large',
        'GitHub monitor response exceeded the byte limit',
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function endpointFor(request: MonitorBrokerRequest): URL {
  const [owner, name] = request.repository.split('/');
  if (!owner || !name) {
    throw new MonitorBrokerFailure(
      'invalid_repository',
      'broker repository identity is invalid',
    );
  }
  const endpoint = request.monitorKind === 'issue' ? 'issues' : 'pulls';
  const url = new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${endpoint}`,
    'https://api.github.com',
  );
  url.searchParams.set('state', 'open');
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('direction', 'asc');
  url.searchParams.set('per_page', '100');
  if (request.monitorKind === 'issue' && request.cursor.updatedAfter !== '') {
    url.searchParams.set('since', request.cursor.updatedAfter);
  }
  return url;
}

function assertTypedPageURL(
  candidate: URL,
  request: MonitorBrokerRequest,
): void {
  const [owner, name] = request.repository.split('/');
  const endpoint = request.monitorKind === 'issue' ? 'issues' : 'pulls';
  const exactPath = `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/${endpoint}`;
  if (
    candidate.protocol !== 'https:'
    || candidate.hostname !== 'api.github.com'
    || candidate.port !== ''
    || candidate.pathname !== exactPath
  ) {
    throw new MonitorBrokerFailure(
      'pagination_escape',
      'GitHub pagination escaped the typed repository operation',
    );
  }
  const allowedKeys = new Set([
    'state',
    'sort',
    'direction',
    'per_page',
    'page',
    ...(request.monitorKind === 'issue' ? ['since'] : []),
  ]);
  if (
    [...candidate.searchParams.keys()].some((key) => !allowedKeys.has(key))
    || candidate.searchParams.get('state') !== 'open'
    || candidate.searchParams.get('sort') !== 'updated'
    || candidate.searchParams.get('direction') !== 'asc'
    || candidate.searchParams.get('per_page') !== '100'
    || (candidate.searchParams.get('page') !== null
      && !/^[1-9][0-9]*$/.test(candidate.searchParams.get('page')!))
    || (request.monitorKind === 'issue'
      && candidate.searchParams.get('since')
        !== (request.cursor.updatedAfter || null))
  ) {
    throw new MonitorBrokerFailure(
      'pagination_escape',
      'GitHub pagination changed the typed query',
    );
  }
}

export class PrivateMonitorBroker {
  private stopping = false;
  private wake: (() => void) | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly intervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxPages: number;

  constructor(private readonly options: PrivateMonitorBrokerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.intervalMs = options.intervalMs ?? 250;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
    this.maxPages = options.maxPages ?? 10;
    if (
      options.repository !== 'mrbaron3/workflow'
      || options.githubToken.trim().length < 20
    ) {
      throw new Error(
        'private monitor broker requires the exact repository allowlist and runner credential',
      );
    }
  }

  requestStop(): void {
    this.stopping = true;
    this.wake?.();
  }

  private async read(
    request: MonitorBrokerRequest,
  ): Promise<Record<string, unknown>> {
    if (request.repository !== this.options.repository) {
      throw new MonitorBrokerFailure(
        'repository_denied',
        'broker request is outside the repository allowlist',
      );
    }
    const cursorTime = request.cursor.updatedAfter === ''
      ? 0
      : Date.parse(request.cursor.updatedAfter);
    if (!Number.isFinite(cursorTime)) {
      throw new MonitorBrokerFailure(
        'invalid_cursor',
        'broker cursor timestamp is invalid',
      );
    }
    let maxUpdated = cursorTime;
    const items: Array<{
      repository: string;
      kind: 'issue' | 'pull_request';
      number: number;
      updatedAt: string;
    }> = [];
    const observedAt = new Date().toISOString();
    if (!this.options.fetchImpl) {
      const endpoint = endpointFor(request);
      const deadline = Date.now() + this.requestTimeoutMs;
      let totalBytes = 0;
      for (let page = 1; page <= this.maxPages; page += 1) {
        endpoint.searchParams.set('page', String(page));
        const endpointArgument = `${endpoint.pathname}${endpoint.search}`;
        const remainingMs = deadline - Date.now();
        const remainingBytes = this.maxResponseBytes - totalBytes;
        if (remainingMs < 1_000 || remainingBytes < 1) {
          throw new MonitorBrokerFailure(
            remainingBytes < 1 ? 'response_too_large' : 'provider_timeout',
            remainingBytes < 1
              ? 'GitHub monitor response exceeded the byte limit'
              : 'typed monitor provider operation exceeded its deadline',
          );
        }
        let stdout: string;
        try {
          const result = await execFileAsync(
            'gh',
            [
              'api',
              '--method', 'GET',
              '--header', 'Accept: application/vnd.github+json',
              '--header', 'X-GitHub-Api-Version: 2022-11-28',
              endpointArgument,
            ],
            {
              encoding: 'utf8',
              timeout: remainingMs,
              maxBuffer: remainingBytes,
              killSignal: 'SIGKILL',
              env: {
                PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
                HOME: '/home/agentops',
                GH_TOKEN: this.options.githubToken,
                GITHUB_TOKEN: this.options.githubToken,
                ...(process.env.HTTP_PROXY
                  ? { HTTP_PROXY: process.env.HTTP_PROXY }
                  : {}),
                ...(process.env.HTTPS_PROXY
                  ? { HTTPS_PROXY: process.env.HTTPS_PROXY }
                  : {}),
                ...(process.env.NO_PROXY
                  ? { NO_PROXY: process.env.NO_PROXY }
                  : {}),
              },
            },
          );
          stdout = result.stdout;
        } catch {
          throw new MonitorBrokerFailure(
            'provider_failure',
            'typed monitor provider operation failed',
          );
        }
        totalBytes += Buffer.byteLength(stdout);
        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          throw new MonitorBrokerFailure(
            'invalid_json',
            'GitHub monitor response was not JSON',
          );
        }
        const rows = z.array(GitHubRow).max(100).parse(parsed);
        for (const row of rows) {
          if (request.monitorKind === 'issue' && row.pull_request !== undefined) {
            continue;
          }
          const updated = Date.parse(row.updated_at);
          if (updated < cursorTime) continue;
          items.push({
            repository: request.repository,
            kind: request.monitorKind,
            number: row.number,
            updatedAt: new Date(updated).toISOString(),
          });
          maxUpdated = Math.max(maxUpdated, updated);
        }
        if (items.length > 1_000) {
          throw new MonitorBrokerFailure(
            'item_limit',
            'GitHub monitor response exceeded the item limit',
          );
        }
        if (rows.length < 100) {
          return {
            items,
            nextCursor: {
              updatedAfter: maxUpdated === 0
                ? ''
                : new Date(maxUpdated).toISOString(),
            },
            observedAt,
          };
        }
      }
      throw new MonitorBrokerFailure(
        'page_limit',
        'GitHub monitor response exceeded the page limit',
      );
    }

    let pageURL: URL | null = endpointFor(request);
    let totalBytes = 0;
    let pages = 0;
    while (pageURL) {
      pages += 1;
      if (pages > this.maxPages) {
        throw new MonitorBrokerFailure(
          'page_limit',
          'GitHub monitor response exceeded the page limit',
        );
      }
      assertTypedPageURL(pageURL, request);
      const response = await this.fetchImpl(pageURL, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.options.githubToken}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'agentops-private-monitor-broker/1',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (!response.ok) {
        throw new MonitorBrokerFailure(
          `github_http_${response.status}`,
          `GitHub typed monitor returned HTTP ${response.status}`,
        );
      }
      const bytes = await readLimitedBody(
        response,
        this.maxResponseBytes - totalBytes,
      );
      totalBytes += bytes.byteLength;
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new MonitorBrokerFailure(
          'invalid_json',
          'GitHub monitor response was not JSON',
        );
      }
      const rows = z.array(GitHubRow).max(100).parse(parsed);
      for (const row of rows) {
        if (request.monitorKind === 'issue' && row.pull_request !== undefined) {
          continue;
        }
        const updated = Date.parse(row.updated_at);
        if (updated < cursorTime) continue;
        items.push({
          repository: request.repository,
          kind: request.monitorKind,
          number: row.number,
          updatedAt: new Date(updated).toISOString(),
        });
        maxUpdated = Math.max(maxUpdated, updated);
      }
      if (items.length > 1_000) {
        throw new MonitorBrokerFailure(
          'item_limit',
          'GitHub monitor response exceeded the item limit',
        );
      }
      const link = nextLink(response.headers.get('link'));
      pageURL = link ? new URL(link) : null;
    }
    return {
      items,
      nextCursor: {
        updatedAfter: maxUpdated === 0
          ? ''
          : new Date(maxUpdated).toISOString(),
      },
      observedAt,
    };
  }

  async runOnce(): Promise<boolean> {
    if (this.stopping) return false;
    let request: MonitorBrokerRequest | null;
    try {
      request = await this.options.store.claimMonitorBrokerRequest({
        workerId: this.options.workerId,
        allowedRepository: this.options.repository,
        leaseMs: 30_000,
      });
    } catch {
      this.options.log?.(
        'typed monitor broker claim unavailable; retrying without stopping execution service',
      );
      return false;
    }
    if (!request) return false;
    try {
      const response = await this.read(request);
      const items = response.items as unknown[];
      await this.options.store.completeMonitorBrokerRequest({
        request,
        workerId: this.options.workerId,
        response,
        itemCount: items.length,
      });
    } catch (error) {
      if (
        error instanceof Error
        && error.message.includes('monitor broker lease is stale or lost')
      ) {
        this.options.log?.(
          'typed monitor broker lease was lost before completion; leaving recovery to the current owner',
        );
        return true;
      }
      const failure = error instanceof MonitorBrokerFailure
        ? error
        : new MonitorBrokerFailure(
          'provider_failure',
          'typed monitor provider operation failed',
        );
      try {
        await this.options.store.failMonitorBrokerRequest({
          request,
          workerId: this.options.workerId,
          code: failure.code,
          message: failure.message,
        });
      } catch {
        this.options.log?.(
          'typed monitor broker failure persistence unavailable; lease expiry will recover the request',
        );
      }
    }
    return true;
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, this.intervalMs);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  async run(): Promise<void> {
    while (!this.stopping) {
      while (!this.stopping && await this.runOnce()) {
        // Drain all typed monitor requests before sleeping.
      }
      if (!this.stopping) await this.wait();
    }
  }
}
