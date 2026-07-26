import { describe, expect, it, vi } from 'vitest';
import type { MonitorBrokerRequest } from '../src/control-store/types.js';
import { PrivateMonitorBroker } from '../src/runner/monitor-broker.js';

const request: MonitorBrokerRequest = {
  id: '11111111-1111-4111-8111-111111111111',
  registrationId: '22222222-2222-4222-8222-222222222222',
  registrationVersion: 1,
  repository: 'mrbaron3/workflow',
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
  it('returns only sanitized issue identities and excludes pull rows', async () => {
    const store = storeFor();
    const fetchImpl = vi.fn(async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer runner-github-token-opaque',
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
      workerId: 'runner-1',
      repository: 'mrbaron3/workflow',
      githubToken: 'runner-github-token-opaque',
      fetchImpl,
    });
    expect(await broker.runOnce()).toBe(true);
    expect(store.failMonitorBrokerRequest).not.toHaveBeenCalled();
    expect(store.completeMonitorBrokerRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        itemCount: 1,
        response: {
          items: [{
            repository: 'mrbaron3/workflow',
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
    expect(serialized).not.toContain('runner-github-token');
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
      workerId: 'runner-1',
      repository: 'mrbaron3/workflow',
      githubToken: 'runner-github-token-opaque',
      fetchImpl,
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

  it('rejects any repository other than the bounded dogfood target', () => {
    expect(() => new PrivateMonitorBroker({
      store: storeFor(),
      workerId: 'runner-1',
      repository: 'other/repository',
      githubToken: 'runner-github-token-opaque',
    })).toThrow(/exact repository allowlist/);
  });

  it('fails closed on provider response byte limits without persisting a body', async () => {
    const store = storeFor();
    const broker = new PrivateMonitorBroker({
      store,
      workerId: 'runner-1',
      repository: 'mrbaron3/workflow',
      githubToken: 'runner-github-token-opaque',
      maxResponseBytes: 1,
      fetchImpl: vi.fn(async () => new Response('[]', { status: 200 })),
    });
    await broker.runOnce();
    expect(store.failMonitorBrokerRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'response_too_large',
        message: 'GitHub monitor response exceeded the byte limit',
      }),
    );
  });
});
