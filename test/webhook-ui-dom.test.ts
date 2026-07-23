import { HTMLButtonElement, Window } from 'happy-dom';
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

    const autoRefresh = document.querySelector('#auto-refresh') as HTMLButtonElement;
    autoRefresh.click();
    expect(autoRefresh.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('#connection-announcement')?.textContent)
      .toContain('一時停止中');

    autoRefresh.click();
    await flush();
    expect(autoRefresh.getAttribute('aria-pressed')).toBe('false');
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
});
