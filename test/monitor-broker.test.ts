import { describe, expect, it, vi } from 'vitest';
import type { MonitorBrokerRequest } from '../src/control-store/types.js';
import {
  MONITOR_BROKER_INTERVAL_MS,
  MONITOR_BROKER_LEASE_MS,
  MONITOR_BROKER_MAX_PAGES,
  MONITOR_BROKER_MAX_RESPONSE_BYTES,
  MONITOR_BROKER_REQUEST_TIMEOUT_MS,
  PrivateMonitorBroker,
} from '../src/runner/monitor-broker.js';

const testAuthorization = 'triage-github-token-opaque';
const githubBroker = {
  url: 'http://github-broker:8083/',
  capability: 'a'.repeat(43),
  role: 'triage' as const,
};
const fetchAuthorization = async () => testAuthorization;

const request: MonitorBrokerRequest = {
  id: '11111111-1111-4111-8111-111111111111',
  registrationId: '22222222-2222-4222-8222-222222222222',
  registrationVersion: 1,
  repository: 'acme/widgets',
  monitorKind: 'issue',
  cursor: { updatedAfter: '' },
  leaseToken: '33333333-3333-4333-8333-333333333333',
};

function storeFor(next: MonitorBrokerRequest | null = request) {
  return {
    claimMonitorBrokerRequest: vi.fn(async () => next),
    completeMonitorBrokerRequest: vi.fn(async (_input: unknown) => undefined),
    failMonitorBrokerRequest: vi.fn(async (_input: unknown) => undefined),
  };
}

describe('typed private-repository monitor broker', () => {
  it('PR-INTENT pins every production broker boundary', () => {
    expect(MONITOR_BROKER_INTERVAL_MS).toBe(250);
    expect(MONITOR_BROKER_REQUEST_TIMEOUT_MS).toBe(20_000);
    expect(MONITOR_BROKER_MAX_RESPONSE_BYTES).toBe(8 * 1024 * 1024);
    expect(MONITOR_BROKER_MAX_PAGES).toBe(10);
    expect(MONITOR_BROKER_LEASE_MS).toBe(30_000);
  });
  it('covers the production gh transport with explicit bounded pagination', async () => {
    const store = storeFor();
    const rows = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      updated_at: '2026-07-26T01:02:03Z',
    }));
    const execFileImpl = vi.fn(async (
      file: string,
      args: string[],
      options?: { env?: NodeJS.ProcessEnv } | null,
    ) => {
      expect(file).toBe('gh');
      expect(args).not.toContain(testAuthorization);
      expect(options?.env?.GH_TOKEN).toBeUndefined();
      expect(options?.env?.AGENTOPS_GITHUB_BROKER_CAPABILITY)
        .toBe(githubBroker.capability);
      return {
        stdout: JSON.stringify(
          execFileImpl.mock.calls.length === 1
            ? rows
            : [{ number: 101, updated_at: '2026-07-26T01:02:04Z' }],
        ),
      };
    });
    const broker = new PrivateMonitorBroker({
      store,
      workerId: 'triage-1',
      githubBroker,
      execFileImpl,
    });
    await broker.runOnce();
    expect(execFileImpl).toHaveBeenCalledTimes(2);
    expect(execFileImpl.mock.calls[0]?.[1].at(-1)).toContain('page=1');
    expect(execFileImpl.mock.calls[1]?.[1].at(-1)).toContain('page=2');
    expect(store.completeMonitorBrokerRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        response: expect.objectContaining({
          nextCursor: { updatedAfter: '2026-07-26T01:02:04.000Z' },
        }),
      }),
    );
  });

  it('fails the production gh transport on page, byte, and timeout bounds', async () => {
    const fullPage = JSON.stringify(Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      updated_at: '2026-07-26T01:02:03Z',
    })));
    for (const scenario of [
      {
        options: {
          maxPages: 1,
          execFileImpl: vi.fn(async () => ({ stdout: fullPage })),
        },
        code: 'page_limit',
      },
      {
        options: {
          maxResponseBytes: 1,
          execFileImpl: vi.fn(async () => ({ stdout: '[]' })),
        },
        code: 'response_too_large',
      },
      {
        options: {
          execFileImpl: vi.fn(async () => {
            const error = new Error('hidden provider timeout') as NodeJS.ErrnoException;
            error.code = 'ETIMEDOUT';
            throw error;
          }),
        },
        code: 'provider_timeout',
      },
    ]) {
      const scenarioStore = storeFor();
      const broker = new PrivateMonitorBroker({
        store: scenarioStore,
        workerId: 'triage-1',
        githubBroker,
        ...scenario.options,
      });
      await broker.runOnce();
      expect(scenarioStore.failMonitorBrokerRequest).toHaveBeenCalledWith(
        expect.objectContaining({ code: scenario.code }),
      );
    }
  });

  it('services Issue and PR broker requests concurrently', async () => {
    const requests = [
      request,
      { ...request, id: '44444444-4444-4444-8444-444444444444', monitorKind: 'pull_request' as const },
    ];
    let inFlight = 0;
    let maxInFlight = 0;
    let completed = 0;
    let broker: PrivateMonitorBroker;
    const store = {
      claimMonitorBrokerRequest: vi.fn(async () => requests.shift() ?? null),
      completeMonitorBrokerRequest: vi.fn(async () => {
        completed += 1;
        if (completed === 2) broker.requestStop();
      }),
      failMonitorBrokerRequest: vi.fn(async () => undefined),
    };
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return new Response('[]', { status: 200 });
    });
    broker = new PrivateMonitorBroker({
      store,
      workerId: 'triage-1',
      githubBroker,
      fetchImpl,
      fetchAuthorization,
      intervalMs: 1,
    });
    await broker.run();
    expect(completed).toBe(2);
    expect(maxInFlight).toBe(2);
  });

  it('returns only sanitized issue identities and excludes pull rows', async () => {
    const store = storeFor();
    const fetchImpl = vi.fn(async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer triage-github-token-opaque',
      });
      return new Response(JSON.stringify([
        {
          number: 17,
          updated_at: '2026-07-26T01:02:03Z',
          title: 'must not cross the broker',
          body: 'must not cross the broker',
        },
        {
          number: 41,
          updated_at: '2026-07-26T01:02:04Z',
          pull_request: { url: 'private-field' },
        },
      ]), { status: 200 });
    });
    const broker = new PrivateMonitorBroker({
      store,
      workerId: 'triage-1',
      githubBroker,
      fetchImpl,
      fetchAuthorization,
    });
    expect(await broker.runOnce()).toBe(true);
    expect(store.failMonitorBrokerRequest).not.toHaveBeenCalled();
    expect(store.completeMonitorBrokerRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        response: {
          items: [{
            repository: 'acme/widgets',
            kind: 'issue',
            number: 17,
            updatedAt: '2026-07-26T01:02:03.000Z',
          }],
          nextCursor: { updatedAfter: '2026-07-26T01:02:03.000Z' },
          observedAt: expect.any(String),
        },
      }),
    );
    const serialized = JSON.stringify(
      store.completeMonitorBrokerRequest.mock.calls[0]?.[0],
    );
    expect(serialized).not.toContain('must not cross');
    expect(serialized).not.toContain('triage-github-token');
  });

  it('fails closed when GitHub pagination escapes the typed operation', async () => {
    const store = storeFor();
    const fetchImpl = vi.fn(async () => new Response('[]', {
      status: 200,
      headers: {
        link: '<https://api.github.com/user/repos?page=2>; rel="next"',
      },
    }));
    const broker = new PrivateMonitorBroker({
      store,
      workerId: 'triage-1',
      githubBroker,
      fetchImpl,
      fetchAuthorization,
    });
    expect(await broker.runOnce()).toBe(true);
    expect(store.completeMonitorBrokerRequest).not.toHaveBeenCalled();
    expect(store.failMonitorBrokerRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'pagination_escape',
        message: 'GitHub pagination escaped the typed repository operation',
      }),
    );
  });

  it('uses each durable Registration request as the repository authority', async () => {
    const registeredRequest = {
      ...request,
      repository: 'design-lab/component-catalog',
    };
    const store = storeFor(registeredRequest);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain('/repos/design-lab/component-catalog/issues');
      return new Response('[]', { status: 200 });
    });
    const broker = new PrivateMonitorBroker({
      store,
      workerId: 'triage-1',
      githubBroker,
      fetchImpl,
      fetchAuthorization,
    });
    await expect(broker.runOnce()).resolves.toBe(true);
    expect(store.failMonitorBrokerRequest).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('fails closed on provider response byte limits without persisting a body', async () => {
    const store = storeFor();
    const broker = new PrivateMonitorBroker({
      store,
      workerId: 'triage-1',
      githubBroker,
      maxResponseBytes: 1,
      fetchImpl: vi.fn(async () => new Response('[]', { status: 200 })),
      fetchAuthorization,
    });
    await broker.runOnce();
    expect(store.failMonitorBrokerRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'response_too_large',
        message: 'GitHub monitor response exceeded the byte limit',
      }),
    );
  });

  it('bounds valid typed pagination independently of response bytes', async () => {
    const store = storeFor();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const current = new URL(String(input));
      return new Response('[]', {
        status: 200,
        headers: {
          link: `<${new URL(
            `${current.pathname}?state=open&sort=updated&direction=asc&per_page=100&page=2`,
            current,
          )}>; rel="next"`,
        },
      });
    });
    const broker = new PrivateMonitorBroker({
      store,
      workerId: 'triage-1',
      githubBroker,
      fetchImpl,
      fetchAuthorization,
      maxPages: 1,
    });
    expect(await broker.runOnce()).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.failMonitorBrokerRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'page_limit',
        message: 'GitHub monitor response exceeded the page limit',
      }),
    );
  });

  it('isolates claim persistence failures from the execution service', async () => {
    const store = storeFor();
    store.claimMonitorBrokerRequest.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    const log = vi.fn();
    const broker = new PrivateMonitorBroker({
      store,
      workerId: 'triage-1',
      githubBroker,
      fetchImpl: vi.fn(),
      fetchAuthorization,
      log,
    });
    await expect(broker.runOnce()).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('claim unavailable'),
    );
  });

  it('does not rewrite a lost completion lease as a provider failure', async () => {
    const store = storeFor();
    store.completeMonitorBrokerRequest.mockRejectedValueOnce(
      new Error('monitor broker lease is stale or lost'),
    );
    const broker = new PrivateMonitorBroker({
      store,
      workerId: 'triage-1',
      githubBroker,
      fetchImpl: vi.fn(async () => new Response('[]', { status: 200 })),
      fetchAuthorization,
    });
    await expect(broker.runOnce()).resolves.toBe(true);
    expect(store.failMonitorBrokerRequest).not.toHaveBeenCalled();
  });

  it('leaves an unpersisted provider failure leased for expiry recovery', async () => {
    const store = storeFor();
    store.failMonitorBrokerRequest.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    const log = vi.fn();
    const broker = new PrivateMonitorBroker({
      store,
      workerId: 'triage-1',
      githubBroker,
      fetchImpl: vi.fn(async () => new Response('invalid json', { status: 200 })),
      fetchAuthorization,
      log,
    });
    await expect(broker.runOnce()).resolves.toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('lease expiry will recover'),
    );
  });
});
