import {
  HTMLButtonElement,
  HTMLFormElement,
  HTMLInputElement,
  Window,
} from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WEBHOOK_UI_VISIBLE_DELIVERY_LIMIT,
  webhookControlHtml,
} from '../src/webhook/ui.js';

interface UiState {
  repositories: Array<Record<string, unknown>>;
  deliveries: Array<Record<string, unknown>>;
  runtime: { forwarders: Array<Record<string, unknown>> };
}

const windows: Window[] = [];

afterEach(() => {
  while (windows.length > 0) windows.pop()!.close();
});

function state(version: number): UiState {
  return {
    repositories: [
      {
        id: 'WHREPO-1',
        repository: 'acme/one',
        enabled: true,
        events: ['pull_request'],
        consumers: ['agentops'],
        workspaceRoot: null,
        updatedAt: `2026-07-23T00:00:0${version}.000Z`,
      },
      {
        id: 'WHREPO-2',
        repository: 'acme/two',
        enabled: false,
        events: ['issues'],
        consumers: ['agentops'],
        workspaceRoot: null,
        updatedAt: '2026-07-23T00:00:00.000Z',
      },
    ],
    deliveries: Array.from({ length: 55 }, (_, index) => ({
      id: `WHDEL-${index}`,
      repository: 'acme/one',
      event: 'pull_request',
      action: 'synchronize',
      status: 'processed',
      attempts: 1,
      lastError: null,
      ignoredReason: null,
      updatedAt: `2026-07-23T00:${String(index).padStart(2, '0')}:00.000Z`,
    })),
    runtime: {
      forwarders: [
        { registrationId: 'WHREPO-1', state: 'running' },
        { registrationId: 'WHREPO-2', state: 'disabled' },
      ],
    },
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('webhook control GUI runtime', () => {
  it('PR-INTENT executes polling, preserves focus, recovers after resume failure, and caps rows', async () => {
    const window = new Window({
      url: 'http://127.0.0.1:8377/',
      settings: { disableJavaScriptEvaluation: false },
    });
    windows.push(window);
    const responses: Array<UiState | Error> = [
      state(0),
      state(1),
      new Error('temporary outage'),
      state(2),
      state(3),
    ];
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      value: vi.fn(async () => {
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return { ok: true, json: async () => next };
      }),
    });
    let intervalCallback: (() => unknown) | null = null;
    Object.defineProperty(window, 'setInterval', {
      configurable: true,
      value: (callback: () => unknown) => {
        intervalCallback = callback;
        return 1;
      },
    });
    Object.defineProperty(window, 'clearInterval', {
      configurable: true,
      value: () => {
        intervalCallback = null;
      },
    });
    const tick = async (): Promise<void> => {
      const callback = intervalCallback;
      if (!callback) throw new Error('polling interval is not active');
      await callback();
    };

    const html = webhookControlHtml();
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
    if (!script) throw new Error('generated GUI has no executable script');
    window.document.write(html.replace(/<script>[\s\S]*<\/script>/, ''));
    window.document.close();
    window.eval(script);
    await flush();

    const document = window.document;
    const autoRefresh = document.querySelector('#auto-refresh') as HTMLButtonElement;
    expect(autoRefresh.textContent).toBe('更新を一時停止');
    expect(autoRefresh.getAttribute('aria-pressed')).toBe('true');
    expect(intervalCallback).not.toBeNull();
    expect([...document.querySelectorAll('#repositories [data-key]')].map(
      (node) => node.getAttribute('data-key'),
    )).toEqual(['WHREPO-1', 'WHREPO-2']);
    expect(document.querySelectorAll('#deliveries [data-key]')).toHaveLength(
      WEBHOOK_UI_VISIBLE_DELIVERY_LIMIT,
    );

    const toggle = document.querySelector('[data-key="WHREPO-1"] .toggle') as HTMLButtonElement;
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    await tick();
    await flush();
    expect(document.activeElement).toBe(
      document.querySelector('[data-key="WHREPO-1"] .toggle'),
    );

    autoRefresh.click();
    expect(autoRefresh.textContent).toBe('更新を再開');
    expect(autoRefresh.getAttribute('aria-pressed')).toBe('false');
    expect(intervalCallback).toBeNull();
    expect(document.querySelector('#connection-announcement')?.textContent)
      .toContain('一時停止中');

    autoRefresh.click();
    await flush();
    expect(autoRefresh.textContent).toBe('更新を一時停止');
    expect(autoRefresh.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('#connection-announcement')?.textContent)
      .toContain('接続できません');
    expect(intervalCallback).not.toBeNull();

    await tick();
    await flush();
    expect(document.querySelector('#connection-announcement')?.textContent)
      .toContain('接続済み');
    expect(document.querySelector('#repositories')?.classList.contains('operational-stale'))
      .toBe(false);

    const announcement = document.querySelector('#connection-announcement')?.textContent;
    await tick();
    await flush();
    expect(document.querySelector('#connection-announcement')?.textContent).toBe(announcement);
    expect(document.querySelector('#last-updated')?.textContent).toContain('最終更新');
  });

  it('PR-INTENT preserves a successful mutation when the follow-up state refresh fails', async () => {
    const window = new Window({
      url: 'http://127.0.0.1:8377/',
      settings: { disableJavaScriptEvaluation: false },
    });
    windows.push(window);
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/api/state') && fetchMock.mock.calls.length > 2) {
        throw new Error('refresh unavailable');
      }
      return {
        ok: true,
        json: async () => url.endsWith('/api/state') ? state(0) : {},
      };
    });
    Object.defineProperty(window, 'fetch', { configurable: true, value: fetchMock });
    Object.defineProperty(window, 'setInterval', {
      configurable: true,
      value: () => 1,
    });
    Object.defineProperty(window, 'clearInterval', {
      configurable: true,
      value: () => {},
    });
    const html = webhookControlHtml();
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
    if (!script) throw new Error('generated GUI has no executable script');
    window.document.write(html.replace(/<script>[\s\S]*<\/script>/, ''));
    window.document.close();
    window.eval(script);
    await flush();

    const toggle = window.document.querySelector(
      '[data-key="WHREPO-1"] .toggle',
    ) as HTMLButtonElement;
    toggle.click();
    await flush();
    await flush();

    const status = window.document.querySelector('#repo-action-WHREPO-1');
    expect(status?.textContent).toContain('状態変更 は完了しましたが、表示の更新に失敗しました');
    expect(status?.textContent).not.toContain('状態変更 に失敗しました');
    expect(fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/api/repositories/WHREPO-1'))).toHaveLength(1);
    expect(window.document.querySelector('#connection-announcement')?.textContent)
      .toContain('接続できません');
  });

  it('PR-INTENT coalesces repeated repository submissions and exposes busy state', async () => {
    const window = new Window({
      url: 'http://127.0.0.1:8377/',
      settings: { disableJavaScriptEvaluation: false },
    });
    windows.push(window);
    let releasePost!: () => void;
    const blockedPost = new Promise<void>((resolve) => { releasePost = resolve; });
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/api/repositories')) {
        await blockedPost;
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => state(0) };
    });
    Object.defineProperty(window, 'fetch', { configurable: true, value: fetchMock });
    Object.defineProperty(window, 'setInterval', { configurable: true, value: () => 1 });
    Object.defineProperty(window, 'clearInterval', { configurable: true, value: () => {} });
    const html = webhookControlHtml();
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
    if (!script) throw new Error('generated GUI has no executable script');
    window.document.write(html.replace(/<script>[\s\S]*<\/script>/, ''));
    window.document.close();
    window.eval(script);
    await flush();

    const form = window.document.querySelector('#repo-form') as HTMLFormElement;
    const repository = form.querySelector('#repository') as HTMLInputElement;
    const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    repository.value = 'acme/new-repository';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute('aria-busy')).toBe('true');
    expect(window.document.querySelector('#notice')?.textContent).toContain('追加しています');
    expect(fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/api/repositories'))).toHaveLength(1);

    releasePost();
    await flush();
    await flush();
    expect(submit.disabled).toBe(false);
    expect(submit.hasAttribute('aria-busy')).toBe(false);
    expect(window.document.querySelector('#notice')?.textContent).toContain('追加しました');
  });

  it('PR-INTENT preserves toggle and retry single-flight state across background polling', async () => {
    const window = new Window({
      url: 'http://127.0.0.1:8377/',
      settings: { disableJavaScriptEvaluation: false },
    });
    windows.push(window);
    let releaseToggle!: () => void;
    let releaseRetry!: () => void;
    const blockedToggle = new Promise<void>((resolve) => { releaseToggle = resolve; });
    const blockedRetry = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const failedDelivery = {
      id: 'WHDEL-failed',
      repository: 'acme/one',
      event: 'pull_request',
      action: 'synchronize',
      status: 'failed',
      attempts: 1,
      lastError: 'delivery failed',
      ignoredReason: null,
      updatedAt: '2026-07-23T00:00:00.000Z',
    };
    let visibleState = { ...state(0), deliveries: [failedDelivery] };
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/repositories/WHREPO-1')) {
        await blockedToggle;
        return { ok: true, json: async () => ({}) };
      }
      if (url.includes('/api/deliveries/WHDEL-failed/retry')) {
        await blockedRetry;
        return { ok: true, json: async () => ({}) };
      }
      expect(init?.method).toBeUndefined();
      return { ok: true, json: async () => visibleState };
    });
    Object.defineProperty(window, 'fetch', { configurable: true, value: fetchMock });
    let intervalCallback: (() => unknown) | null = null;
    Object.defineProperty(window, 'setInterval', {
      configurable: true,
      value: (callback: () => unknown) => {
        intervalCallback = callback;
        return 1;
      },
    });
    Object.defineProperty(window, 'clearInterval', {
      configurable: true,
      value: () => {
        intervalCallback = null;
      },
    });
    const html = webhookControlHtml();
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
    if (!script) throw new Error('generated GUI has no executable script');
    window.document.write(html.replace(/<script>[\s\S]*<\/script>/, ''));
    window.document.close();
    window.eval(script);
    await flush();

    (window.document.querySelector('[data-key="WHREPO-1"] .toggle') as HTMLButtonElement).click();
    (window.document.querySelector('[data-key="WHDEL-failed"] .retry') as HTMLButtonElement).click();
    await flush();

    visibleState = {
      ...state(1),
      deliveries: [{ ...failedDelivery, updatedAt: '2026-07-23T00:00:01.000Z' }],
    };
    if (!intervalCallback) throw new Error('polling interval is not active');
    await (intervalCallback as unknown as () => unknown)();
    await flush();

    const liveToggle = window.document.querySelector(
      '[data-key="WHREPO-1"] .toggle',
    ) as HTMLButtonElement;
    const liveRetry = window.document.querySelector(
      '[data-key="WHDEL-failed"] .retry',
    ) as HTMLButtonElement;
    expect(liveToggle.disabled).toBe(true);
    expect(liveRetry.disabled).toBe(true);
    expect(liveToggle.getAttribute('aria-busy')).toBe('true');
    expect(liveRetry.getAttribute('aria-busy')).toBe('true');
    expect(window.document.querySelector('#repo-action-WHREPO-1')?.textContent)
      .toContain('実行中');
    expect(window.document.querySelector('#delivery-action-WHDEL-failed')?.textContent)
      .toContain('実行中');
    liveToggle.click();
    liveRetry.click();
    expect(fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/api/repositories/WHREPO-1'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/api/deliveries/WHDEL-failed/retry'))).toHaveLength(1);

    releaseToggle();
    releaseRetry();
    await flush();
    await flush();
    await flush();

    const completedToggle = window.document.querySelector(
      '[data-key="WHREPO-1"] .toggle',
    ) as HTMLButtonElement;
    const completedRetry = window.document.querySelector(
      '[data-key="WHDEL-failed"] .retry',
    ) as HTMLButtonElement;
    expect(completedToggle.disabled).toBe(false);
    expect(completedRetry.disabled).toBe(false);
    expect(completedToggle.hasAttribute('aria-busy')).toBe(false);
    expect(completedRetry.hasAttribute('aria-busy')).toBe(false);
    expect(window.document.querySelector('#repo-action-WHREPO-1')?.textContent)
      .toContain('完了しました');
    expect(window.document.querySelector('#delivery-action-WHDEL-failed')?.textContent)
      .toContain('完了しました');
  });

  it('PR-INTENT moves focus to the deliveries region when passive polling removes the focused retry row', async () => {
    const window = new Window({
      url: 'http://127.0.0.1:8377/',
      settings: { disableJavaScriptEvaluation: false },
    });
    windows.push(window);
    const failedDelivery = {
      ...state(0),
      deliveries: [{
        id: 'WHDEL-failed',
        repository: 'acme/one',
        event: 'pull_request',
        action: 'synchronize',
        status: 'failed',
        attempts: 1,
        lastError: 'delivery failed',
        ignoredReason: null,
        updatedAt: '2026-07-23T00:00:00.000Z',
      }],
    };
    const responses = [failedDelivery, { ...state(1), deliveries: [] }];
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      value: vi.fn(async () => ({ ok: true, json: async () => responses.shift() })),
    });
    let intervalCallback: (() => unknown) | null = null;
    Object.defineProperty(window, 'setInterval', {
      configurable: true,
      value: (callback: () => unknown) => {
        intervalCallback = callback;
        return 1;
      },
    });
    Object.defineProperty(window, 'clearInterval', {
      configurable: true,
      value: () => {
        intervalCallback = null;
      },
    });
    const html = webhookControlHtml();
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
    if (!script) throw new Error('generated GUI has no executable script');
    window.document.write(html.replace(/<script>[\s\S]*<\/script>/, ''));
    window.document.close();
    window.eval(script);
    await flush();

    const retry = window.document.querySelector('#deliveries .retry') as HTMLButtonElement;
    const deliveriesRegion = window.document.querySelector('.table-wrap');
    retry.focus();
    expect(window.document.activeElement).toBe(retry);
    if (!intervalCallback) throw new Error('polling interval is not active');
    await (intervalCallback as unknown as () => unknown)();
    await flush();

    expect(window.document.querySelector('#deliveries [data-empty]')).not.toBeNull();
    expect(window.document.activeElement).toBe(deliveriesRegion);
  });
});
