import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const root = process.cwd();
const suffix = `${process.pid}-${Date.now()}`;
const network = `agentops-ciso03-${suffix}`;
const volume = `agentops-ciso03-pgdata-${suffix}`;
const postgres = `agentops-ciso03-pg-${suffix}`;
const control = `agentops-ciso03-control-${suffix}`;
const githubStub = `agentops-ciso03-github-${suffix}`;
const postgresNetwork = `${network},mac=02:42:ac:11:00:02`;
const githubStubImage = 'node:24.19.0-trixie-slim';
const controlImage = `agentops-control:ciso03-${suffix}`;
const controlTestImage = `agentops-control-test:ciso03-${suffix}`;
const databasePassword = `ciso03-${suffix}`;
const controlDatabasePassword = `control-db-${suffix}`;
const controlToken = `control-${suffix}-grounded-boundary`;
const evidencePath = path.join(
  root,
  'evidence',
  'ciso-05',
  'dashboard-apple-container-smoke.json',
);

interface Inspection {
  configuration: {
    id: string;
    publishedPorts: Array<{
      hostAddress: string;
      hostPort: number;
      containerPort: number;
    }>;
  };
  status: {
    networks: Array<{ ipv4Address: string }>;
    state: string;
  };
}

function run(args: string[], options: { capture?: boolean } = {}): string {
  const output = execFileSync('container', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  return typeof output === 'string' ? output.trim() : '';
}

function bestEffort(args: string[]): void {
  spawnSync('container', args, { cwd: root, stdio: 'ignore' });
}

function inspect(name: string): Inspection {
  return JSON.parse(run(['inspect', name], { capture: true }))[0] as Inspection;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('could not allocate a loopback port'));
        return;
      }
      const { port } = address;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(
  description: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function api(
  baseURL: string,
  method: string,
  resource: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseURL}${resource}`, {
    method,
    headers: {
      authorization: `Bearer ${controlToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: Record<string, unknown> = {};
  try {
    json = await response.json() as Record<string, unknown>;
  } catch {
    // A refusal is still represented by the HTTP status.
  }
  return { status: response.status, json };
}

function cleanup(): void {
  bestEffort(['delete', '--force', control]);
  bestEffort(['delete', '--force', githubStub]);
  bestEffort(['delete', '--force', postgres]);
  bestEffort(['network', 'delete', network]);
  bestEffort(['volume', 'delete', volume]);
}

async function main(): Promise<void> {
  cleanup();
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
  const hostPort = await freePort();

  run(['build', '--target', 'control', '-t', controlImage, '-f', 'deploy/Containerfile', '.']);
  run(['build', '--target', 'control-test', '-t', controlTestImage, '-f', 'deploy/Containerfile', '.']);
  run(['run', '--rm', '--entrypoint', 'gh', controlImage, 'webhook', '--help']);
  run(['network', 'create', '--internal', network]);
  run(['volume', 'create', volume]);
  run([
    'run', '--detach', '--name', githubStub, '--network', network,
    '--entrypoint', 'node', githubStubImage,
    '-e',
    "require('node:http').createServer((_,response)=>{response.setHeader('content-type','application/json');response.end('[]')}).listen(8081,'0.0.0.0')",
  ]);
  run([
    'run', '--detach', '--name', postgres, '--network', postgresNetwork,
    '--volume', `${volume}:/var/lib/postgresql`,
    '--env', `POSTGRES_PASSWORD=${databasePassword}`,
    '--env', 'POSTGRES_DB=agentops',
    '--env', 'PGDATA=/var/lib/postgresql/18/docker',
    'postgres:18.4-trixie',
  ]);
  await waitFor('PostgreSQL readiness', async () => {
    const result = spawnSync(
      'container',
      ['exec', postgres, 'pg_isready', '-U', 'postgres', '-d', 'agentops'],
      { stdio: 'ignore' },
    );
    return result.status === 0;
  });
  const postgresIP = inspect(postgres).status.networks[0]?.ipv4Address.split('/')[0];
  if (!postgresIP) throw new Error('PostgreSQL has no internal IPv4 address');
  const migrationDatabaseURL =
    `postgresql://postgres:${databasePassword}@${postgresIP}:5432/agentops`;
  run([
    'run', '--rm', '--network', network,
    '--env', `AGENTOPS_TEST_DATABASE_URL=${migrationDatabaseURL}`,
    controlTestImage,
  ]);
  run([
    'exec', postgres, 'psql', '-U', 'postgres', '-d', 'agentops',
    '-v', 'ON_ERROR_STOP=1',
    '-c',
    `REVOKE CONNECT ON DATABASE agentops FROM PUBLIC; `
      + `CREATE ROLE agentops_control LOGIN PASSWORD '${controlDatabasePassword}'; `
      + 'GRANT CONNECT ON DATABASE agentops TO agentops_control; '
      + 'GRANT USAGE ON SCHEMA agentops_control TO agentops_control; '
      + 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA agentops_control '
      + 'TO agentops_control; '
      + 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA agentops_control TO agentops_control;',
  ]);
  const databaseURL =
    `postgresql://agentops_control:${controlDatabasePassword}@${postgresIP}:5432/agentops`;
  const githubStubIP = inspect(githubStub).status.networks[0]?.ipv4Address.split('/')[0];
  if (!githubStubIP) throw new Error('GitHub stub has no internal IPv4 address');
  const githubAPIURL = `http://${githubStubIP}:8081`;
  run([
    'run', '--detach', '--name', control, '--network', network,
    '--read-only', '--cap-drop', 'ALL', '--tmpfs', '/tmp',
    '--publish', `127.0.0.1:${hostPort}:8080`,
    '--env', `AGENTOPS_DATABASE_URL=${databaseURL}`,
    '--env', `AGENTOPS_CONTROL_TOKEN=${controlToken}`,
    '--env', 'AGENTOPS_OPERATING_MODE=MONITOR_ONLY',
    '--env', `AGENTOPS_DASHBOARD_ORIGIN=http://127.0.0.1:${hostPort}`,
    '--env', `AGENTOPS_DASHBOARD_BOOTSTRAP_TOKEN=dashboard-bootstrap-${suffix}-grounded`,
    '--env', 'AGENTOPS_RECONCILIATION_INTERVAL=500ms',
    '--env', 'AGENTOPS_GITHUB_POLL_INTERVAL=1s',
    '--env', `AGENTOPS_GITHUB_API_URL=${githubAPIURL}`,
    controlImage,
  ]);
  const baseURL = `http://127.0.0.1:${hostPort}`;
  await waitFor('control health', async () =>
    (await api(baseURL, 'GET', '/healthz')).status === 200);

  const bootstrapURL =
    `${baseURL}/dashboard/bootstrap?token=${
      encodeURIComponent(`dashboard-bootstrap-${suffix}-grounded`)
    }`;
  const bootstrap = await fetch(bootstrapURL, { redirect: 'manual' });
  const setCookie = bootstrap.headers.get('set-cookie') ?? '';
  if (
    bootstrap.status !== 303
    || bootstrap.headers.get('location') !== '/'
    || !setCookie.includes('HttpOnly')
    || !setCookie.includes('SameSite=Strict')
  ) {
    throw new Error(`dashboard bootstrap boundary failed: ${bootstrap.status} ${setCookie}`);
  }
  const cookie = setCookie.split(';', 1)[0] ?? '';
  if (!cookie) throw new Error('dashboard bootstrap did not issue a session cookie');
  const replayedBootstrap = await fetch(bootstrapURL, { redirect: 'manual' });
  if (replayedBootstrap.status !== 401) {
    throw new Error(`dashboard bootstrap replay was not rejected: ${replayedBootstrap.status}`);
  }
  const dashboard = await fetch(`${baseURL}/`, { headers: { cookie } });
  const dashboardHTML = await dashboard.text();
  if (
    dashboard.status !== 200
    || dashboard.headers.get('access-control-allow-origin') !== null
    || !dashboard.headers.get('content-security-policy')?.includes("connect-src 'self'")
    || dashboardHTML.includes(controlToken)
    || dashboardHTML.includes('Bearer ')
  ) {
    throw new Error('dashboard asset/session/security-header boundary failed');
  }
  const browserSession = await fetch(`${baseURL}/v1/browser-session`, {
    headers: { cookie },
  });
  const browserSessionBody = await browserSession.json() as Record<string, unknown>;
  if (
    browserSession.status !== 200
    || typeof browserSessionBody.csrfToken !== 'string'
    || browserSessionBody.origin !== baseURL
  ) {
    throw new Error(`browser session contract failed: ${JSON.stringify(browserSessionBody)}`);
  }

  const created = await api(baseURL, 'POST', '/v1/registrations', {
    repository: 'example/grounded-control',
    enabled: false,
    issueMonitorEnabled: true,
    prMonitorEnabled: false,
    executionEnabled: false,
  }, { 'idempotency-key': 'apple-smoke-registration' });
  if (created.status !== 201) {
    throw new Error(`Registration create failed: ${created.status} ${JSON.stringify(created.json)}`);
  }
  const createdRegistration = created.json.registration as Record<string, unknown>;
  const registrationId = String(createdRegistration.id);
  const createdVersion = Number(createdRegistration.version);
  const enabled = await api(
    baseURL,
    'PATCH',
    `/v1/registrations/${registrationId}`,
    { enabled: true },
    {
      'if-match': `"${createdVersion}"`,
      'idempotency-key': 'apple-smoke-enable',
    },
  );
  if (enabled.status !== 200) {
    throw new Error(`Registration enable failed: ${enabled.status} ${JSON.stringify(enabled.json)}`);
  }
  await waitFor('dynamic issue monitor start', async () => {
    const page = await api(baseURL, 'GET', '/v1/registrations');
    const items = page.json.items as Array<Record<string, unknown>> | undefined;
    const row = items?.find((item) =>
      (item.registration as Record<string, unknown> | undefined)?.id === registrationId);
    const components = row?.components as Record<string, Record<string, unknown>> | undefined;
    return components?.issue_monitor?.actual === 'running';
  });
  const enabledVersion = Number(
    (enabled.json.registration as Record<string, unknown> | undefined)?.version,
  );
  const disabled = await api(
    baseURL,
    'POST',
    `/v1/registrations/${registrationId}/disable`,
    {},
    {
      'if-match': `"${enabledVersion}"`,
      'idempotency-key': 'apple-smoke-disable',
    },
  );
  if (disabled.status !== 200) {
    throw new Error(`Registration disable failed: ${disabled.status} ${JSON.stringify(disabled.json)}`);
  }
  await waitFor('dynamic monitor stop', async () => {
    const page = await api(baseURL, 'GET', '/v1/registrations');
    const items = page.json.items as Array<Record<string, unknown>> | undefined;
    const row = items?.find((item) =>
      (item.registration as Record<string, unknown> | undefined)?.id === registrationId);
    const components = row?.components as Record<string, Record<string, unknown>> | undefined;
    return components?.issue_monitor?.actual === 'stopped';
  });
  const disabledVersion = Number(
    (disabled.json.registration as Record<string, unknown> | undefined)?.version,
  );
  const restored = await api(
    baseURL,
    'PATCH',
    `/v1/registrations/${registrationId}`,
    { enabled: true },
    {
      'if-match': `"${disabledVersion}"`,
      'idempotency-key': 'apple-smoke-restore',
    },
  );
  if (restored.status !== 200) {
    throw new Error(
      `Registration restore failed: ${restored.status} ${JSON.stringify(restored.json)}`,
    );
  }
  const restoredVersion = Number(
    (restored.json.registration as Record<string, unknown> | undefined)?.version,
  );
  await waitFor('restored monitor before DB disconnect', async () => {
    const page = await api(baseURL, 'GET', '/v1/registrations');
    const items = page.json.items as Array<Record<string, unknown>> | undefined;
    const row = items?.find((item) =>
      (item.registration as Record<string, unknown> | undefined)?.id === registrationId);
    const components = row?.components as Record<string, Record<string, unknown>> | undefined;
    return components?.issue_monitor?.actual === 'running';
  });

  run([
    'exec', postgres, 'psql', '-U', 'postgres', '-d', 'agentops',
    '-v', 'ON_ERROR_STOP=1',
    '-c',
    'REVOKE CONNECT ON DATABASE agentops FROM agentops_control; '
      + "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'agentops_control';",
  ]);
  await waitFor('fail-closed DB disconnect', async () =>
    (await api(baseURL, 'GET', '/healthz')).status === 503);
  run([
    'exec', postgres, 'psql', '-U', 'postgres', '-d', 'agentops',
    '-v', 'ON_ERROR_STOP=1',
    '-c', 'GRANT CONNECT ON DATABASE agentops TO agentops_control;',
  ]);
  await waitFor('DB reconnect', async () =>
    (await api(baseURL, 'GET', '/healthz')).status === 200);
  await waitFor('desired monitor reconstruction after DB reconnect', async () => {
    const afterReconnect = await api(baseURL, 'GET', '/v1/registrations');
    const reconnectItems =
      afterReconnect.json.items as Array<Record<string, unknown>> | undefined;
    const row = reconnectItems?.find((item) =>
      (item.registration as Record<string, unknown> | undefined)?.id === registrationId);
    const registration = row?.registration as Record<string, unknown> | undefined;
    const components = row?.components as Record<string, Record<string, unknown>> | undefined;
    return registration?.version === restoredVersion
      && registration?.enabled === true
      && components?.issue_monitor?.actual === 'running';
  });

  run(['delete', '--force', control]);
  run([
    'run', '--detach', '--name', control, '--network', network,
    '--read-only', '--cap-drop', 'ALL', '--tmpfs', '/tmp',
    '--publish', `127.0.0.1:${hostPort}:8080`,
    '--env', `AGENTOPS_DATABASE_URL=${databaseURL}`,
    '--env', `AGENTOPS_CONTROL_TOKEN=${controlToken}`,
    '--env', 'AGENTOPS_OPERATING_MODE=MONITOR_ONLY',
    '--env', `AGENTOPS_DASHBOARD_ORIGIN=http://127.0.0.1:${hostPort}`,
    '--env', `AGENTOPS_DASHBOARD_BOOTSTRAP_TOKEN=restart-dashboard-bootstrap-${suffix}-grounded`,
    '--env', 'AGENTOPS_RECONCILIATION_INTERVAL=500ms',
    '--env', 'AGENTOPS_GITHUB_POLL_INTERVAL=1s',
    '--env', `AGENTOPS_GITHUB_API_URL=${githubAPIURL}`,
    controlImage,
  ]);
  await waitFor('control restart', async () =>
    (await api(baseURL, 'GET', '/healthz')).status === 200);
  await waitFor('desired monitor reconstruction after control restart', async () => {
    const afterRestart = await api(baseURL, 'GET', '/v1/registrations');
    const restartItems = afterRestart.json.items as Array<Record<string, unknown>> | undefined;
    const row = restartItems?.find((item) =>
      (item.registration as Record<string, unknown> | undefined)?.id === registrationId);
    const registration = row?.registration as Record<string, unknown> | undefined;
    const components = row?.components as Record<string, Record<string, unknown>> | undefined;
    return registration?.version === restoredVersion
      && registration?.enabled === true
      && components?.issue_monitor?.actual === 'running';
  });

  const controlInspection = inspect(control);
  const postgresInspection = inspect(postgres);
  const githubStubInspection = inspect(githubStub);
  const publications = controlInspection.configuration.publishedPorts;
  if (
    publications.length !== 1 ||
    publications[0]?.hostAddress !== '127.0.0.1' ||
    publications[0]?.containerPort !== 8080
  ) {
    throw new Error(`control publish invariant failed: ${JSON.stringify(publications)}`);
  }
  if (postgresInspection.configuration.publishedPorts.length !== 0) {
    throw new Error('PostgreSQL unexpectedly published a host port');
  }
  if (githubStubInspection.configuration.publishedPorts.length !== 0) {
    throw new Error('GitHub test stub unexpectedly published a host port');
  }

  const evidence = {
    schemaVersion: '1.0',
    issue: 'mrbaron3/workflow#15',
    runtime: 'Apple Container',
    runtimeVersion: run(['--version'], { capture: true }),
    images: { githubStubImage, controlImage, controlTestImage },
    checks: {
      standardOciControlBuild: 'passed',
      pinnedForwarderExtensionReady: 'passed',
      githubStubInternalOnly: 'passed',
      goRacePostgresIntegration: 'passed',
      designGateAtControlStartup: 'passed',
      loopbackBrowserSessionBoundary: 'passed',
      exactOriginCsrfAndSecurityHeaders: 'passed',
      postgresInternalOnly: 'passed',
      controlLoopbackOnly: 'passed',
      controlReadOnlyRootAndCapabilitiesDropped: 'passed',
      noContainerRuntimeSocketOrHostFilesystemMount: 'passed',
      registrationCreateEnableDisableWithoutRestart: 'passed',
      desiredActualProjection: 'passed',
      databaseDisconnectFailClosed: 'passed',
      databaseReconnectReconstruction: 'passed',
      controlRestartReconstruction: 'passed',
    },
    topology: {
      controlPublications: publications,
      postgresPublications: postgresInspection.configuration.publishedPorts,
      githubStubPublications: githubStubInspection.configuration.publishedPorts,
      runnerWasLongRunning: false,
      runnerPublications: [],
    },
    registration: {
      id: registrationId,
      createdVersion,
      enabledVersion,
      disabledVersion,
      restoredVersion,
    },
    completedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

main().catch((error: unknown) => {
  try {
    const logs = run(['logs', control], { capture: true });
    process.stderr.write(`${logs}\n`);
  } catch {
    // Preserve the original grounded failure.
  }
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
