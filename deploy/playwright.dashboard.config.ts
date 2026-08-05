import { defineConfig } from '@playwright/test';
import { REPOSITORY_ROOT } from '../apps/agentops/src/runtime/roots.js';

const port = Number(process.env.AGENTOPS_DASHBOARD_TEST_PORT ?? '18080');
const baseURL = `http://127.0.0.1:${port}`;
const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export default defineConfig({
  testDir: `${REPOSITORY_ROOT}/deploy/test/dashboard`,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['line']],
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    launchOptions: process.platform === 'darwin'
      ? { executablePath: localChrome }
      : undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'tsx deploy/scripts/ciso05-dashboard-test-server.ts',
    cwd: REPOSITORY_ROOT,
    url: `${baseURL}/healthz`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      AGENTOPS_DASHBOARD_TEST_PORT: String(port),
      ...(process.platform === 'darwin' ? { MISE_GO_VERSION: '1.23.12' } : {}),
    },
  },
});
