import { expect, test, type Page } from '@playwright/test';

async function bootstrap(page: Page): Promise<void> {
  await page.goto('/dashboard/bootstrap?token=dashboard-browser-bootstrap-token');
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'AgentOps Control' })).toBeVisible();
  await expect(page.locator('#mode')).toHaveText('MONITOR_ONLY');
}

test('CRUD, desired/actual divergence, announcements, and same-origin network boundary', async ({
  page,
  baseURL,
}) => {
  const hosts = new Set<string>();
  page.on('request', (request) => hosts.add(new URL(request.url()).origin));
  await bootstrap(page);

  await page.getByRole('button', { name: 'Registration を追加' }).click();
  await expect(page.locator('#repository')).toBeFocused();
  await page.locator('#repository').fill('example/browser-control');
  await page.locator('#pr-enabled').uncheck();
  await page.locator('#execution-enabled').uncheck();
  await page.getByRole('button', { name: '保存' }).click();

  const card = page.locator('.card', { hasText: 'example/browser-control' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('version 1');
  await expect(card.locator('[aria-label="Issue Monitor"]')).toContainText('desired: ON');
  await expect(card.locator('[aria-label="Execution"]')).toContainText('desired: OFF');
  await expect(page.locator('#live')).toContainText('反映を確認しました');

  await card.getByRole('button', { name: '編集' }).click();
  await expect(page.locator('#repository')).toBeFocused();
  await page.locator('#issue-enabled').uncheck();
  await page.getByRole('button', { name: '保存' }).click();
  await expect(card).toContainText('version 2');
  await expect(card.locator('[aria-label="Issue Monitor"]')).toContainText('desired: OFF');

  const registrationId = await card.getAttribute('data-id');
  await page.route(new RegExp(`/v1/registrations/${registrationId}$`), async (route) => {
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        outcome: {
          outcome: 'version_conflict',
          reason: 'registration_version_mismatch',
          recoverability: 'refresh_and_retry_with_current_version',
        },
        error: {
          code: 'registration_version_mismatch',
          message: 'Registration version changed',
        },
      }),
    });
  }, { times: 1 });
  await card.getByRole('button', { name: '編集' }).click();
  await page.locator('#pr-enabled').check();
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('#registration-error')).toBeFocused();
  await expect(page.locator('#registration-error')).toContainText('refresh_and_retry_with_current_version');
  await expect(page.locator('#registration-reload')).toBeVisible();
  await expect(page.locator('#save-registration')).toBeDisabled();
  await expect(page.locator('#pr-enabled')).toBeChecked();
  await page.locator('#registration-reload').click();
  await expect(page.locator('#registration-dialog')).not.toBeVisible();
  await expect(card.getByRole('button', { name: 'example/browser-control の状態詳細を選択' })).toBeFocused();

  const snapshot = await page.evaluate(async () =>
    (await fetch('/v1/registrations?limit=200')).json()) as {
      items: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
  const deliveryId = '00000000-0000-4000-8000-000000000015';
  const registration = snapshot.items[0]!.registration as Record<string, unknown>;
  snapshot.items[0]!.recentDeliveryFailures = [{
    id: deliveryId,
    deliveryKey: 'browser-failed-delivery',
    event: 'issues',
    action: 'opened',
    status: 'failed',
    ignoredReason: null,
    lastError: 'transient delivery failure',
    routeAttempts: 2,
    registrationVersion: registration.version,
    updatedAt: '2026-07-26T00:00:00Z',
  }];
  await page.route('**/v1/registrations?limit=200', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) });
  }, { times: 1 });
  let deliveryState = 'failed';
  await page.route(new RegExp(`/v1/deliveries/${deliveryId}(?:/retry)?$`), async (route) => {
    if (route.request().method() === 'POST') {
      deliveryState = 'pending';
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          outcome: { outcome: 'applied' },
          retry: {
            attemptId: '00000000-0000-4000-8000-000000000016',
            deliveryId,
            state: 'pending',
            cancellable: false,
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: deliveryId,
        status: deliveryState,
        routeAttempts: 2,
        registrationId: registration.id,
        registrationVersion: registration.version,
        lastError: deliveryState === 'failed' ? 'transient delivery failure' : null,
        ignoredReason: null,
        updatedAt: '2026-07-26T00:00:00Z',
        retryAttempts: deliveryState === 'pending' ? [{
          attemptId: '00000000-0000-4000-8000-000000000016',
          status: 'accepted',
        }] : [],
      }),
    });
  });
  await page.getByRole('button', { name: '再取得' }).click();
  await card.locator('summary').click();
  await card.getByRole('button', { name: '確認・再試行' }).click();
  await expect(page.locator('#retry-delivery')).toBeFocused();
  await page.locator('#retry-delivery').click();
  await expect(page.locator('#live')).toContainText('再試行受付を確認しました');

  await card.getByRole('button', { name: '無効化' }).click();
  await expect(page.locator('#confirm-title')).toBeFocused();
  await page.locator('#confirm-dialog .danger').click();
  await expect(card).toContainText('version 3 · disabled');
  await expect(page.locator('#live')).toContainText('無効化を確認しました');
  await expect(card.getByRole('button', { name: 'example/browser-control の状態詳細を選択' })).toBeFocused();

  await page.setViewportSize({ width: 320, height: 800 });
  await page.getByRole('button', { name: 'Registration を追加' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#registration-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#registration-dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Registration を追加' })).toBeFocused();

  await page.route('**/v1/registrations?limit=200', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'control_store_unavailable',
          message: 'control store unavailable',
          retryable: true,
          lastSuccessfulAt: '2026-07-26T00:00:00Z',
        },
      }),
    });
  }, { times: 3 });
  await page.getByRole('button', { name: '再取得' }).click();
  await expect(page.getByRole('alert')).toContainText('表示中の値は最終正常取得');
  await expect(page.locator('#live')).toContainText('Control API 接続失敗');
  await expect(page.getByRole('button', { name: 'Registration を追加' })).toBeDisabled();
  await expect(card.getByRole('button', { name: '編集' })).toBeDisabled();
  await expect(card.getByRole('button', { name: '無効化' })).toBeDisabled();

  const dimensions = await page.evaluate(() => {
    const browser = globalThis as unknown as {
      document: { documentElement: { clientWidth: number; scrollWidth: number } };
    };
    return {
      client: browser.document.documentElement.clientWidth,
      scroll: browser.document.documentElement.scrollWidth,
    };
  });
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
  await expect(page.locator('label[for="search"]')).toHaveText('リポジトリ');

  expect([...hosts]).toEqual([baseURL]);
  await expect(page.evaluate(() => {
    const browser = globalThis as unknown as {
      localStorage: Record<string, unknown>;
      sessionStorage: Record<string, unknown>;
      document: { documentElement: { textContent: string | null } };
    };
    return {
      local: Object.keys(browser.localStorage),
      session: Object.keys(browser.sessionStorage),
      bearerInDOM: browser.document.documentElement.textContent?.includes('Bearer '),
    };
  })).resolves.toEqual({ local: [], session: [], bearerInDOM: false });
});
