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
const runnerImage = `agentops-runner:ciso03-${suffix}`;
const controlImage = `agentops-control:ciso03-${suffix}`;
const controlTestImage = `agentops-control-test:ciso03-${suffix}`;
const databasePassword = `ciso03-${suffix}`;
const controlDatabasePassword = `control-db-${suffix}`;
const controlToken = `control-${suffix}`;
const evidencePath = path.join(root, 'evidence', 'ciso-03', 'apple-container-smoke.json');

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

  run(['build', '--target', 'runtime', '-t', runnerImage, '-f', 'deploy/Containerfile', '.']);
  run(['build', '--target', 'control', '-t', controlImage, '-f', 'deploy/Containerfile', '.']);
  run(['build', '--target', 'control-test', '-t', controlTestImage, '-f', 'deploy/Containerfile', '.']);
  run(['run', '--rm', '--entrypoint', 'gh', controlImage, 'webhook', '--help']);
  run(['network', 'create', '--internal', network]);
  run(['volume', 'create', volume]);
  run([
    'run', '--detach', '--name', githubStub, '--network', network,
    '--entrypoint', 'node', runnerImage,
    '-e',
    "require('node:http').createServer((_,response)=>{response.setHeader('content-type','application/json');response.end('[]')}).listen(8081,'0.0.0.0')",
  ]);
  run([
    'run', '--detach', '--name', postgres, '--network', postgresNetwork,
    '--volume', `${volume}:/var/lib/postgresql`,
    '--env', `POSTGRES_PASSWORD=${databasePassword}`,
    '--env', 'POSTGRES_DB=agentops',
    '--env', 'PGDATA=/var/lib/postgresql/data',
    'postgres:16',
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
    'run', '--rm', '--network', network,
    '--env', `AGENTOPS_DATABASE_URL=${migrationDatabaseURL}`,
    runnerImage,
    'npm', 'run', 'control-store:migrate',
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
    '--publish', `127.0.0.1:${hostPort}:8080`,
    '--env', `AGENTOPS_DATABASE_URL=${databaseURL}`,
    '--env', `AGENTOPS_CONTROL_TOKEN=${controlToken}`,
    '--env', 'AGENTOPS_RECONCILIATION_INTERVAL=500ms',
    '--env', 'AGENTOPS_GITHUB_POLL_INTERVAL=1s',
    '--env', `AGENTOPS_GITHUB_API_URL=${githubAPIURL}`,
    controlImage,
  ]);
  const baseURL = `http://127.0.0.1:${hostPort}`;
  await waitFor('control health', async () =>
    (await api(baseURL, 'GET', '/healthz')).status === 200);

  const created = await api(baseURL, 'POST', '/v1/registrations', {
    repository: 'example/grounded-control',
    enabled: false,
    issueMonitorEnabled: true,
    prMonitorEnabled: false,
    executionEnabled: false,
    configuration: {},
  }, { 'idempotency-key': 'apple-smoke-registration' });
  if (created.status !== 201) {
    throw new Error(`Registration create failed: ${created.status} ${JSON.stringify(created.json)}`);
  }
  const registrationId = String(created.json.id);
  const createdVersion = Number(created.json.version);
  const enabled = await api(
    baseURL,
    'PATCH',
    `/v1/registrations/${registrationId}`,
    { enabled: true },
    { 'if-match': `"${createdVersion}"` },
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
    return components?.issue_monitor?.state === 'running';
  });
  const enabledVersion = Number(enabled.json.version);
  const disabled = await api(
    baseURL,
    'POST',
    `/v1/registrations/${registrationId}/disable`,
    undefined,
    { 'if-match': `"${enabledVersion}"` },
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
    return components?.issue_monitor?.state === 'stopped';
  });
  const disabledVersion = Number(
    (disabled.json.registration as Record<string, unknown> | undefined)?.version,
  );
  const restored = await api(
    baseURL,
    'PATCH',
    `/v1/registrations/${registrationId}`,
    { enabled: true },
    { 'if-match': `"${disabledVersion}"` },
  );
  if (restored.status !== 200) {
    throw new Error(
      `Registration restore failed: ${restored.status} ${JSON.stringify(restored.json)}`,
    );
  }
  const restoredVersion = Number(restored.json.version);
  await waitFor('restored monitor before DB disconnect', async () => {
    const page = await api(baseURL, 'GET', '/v1/registrations');
    const items = page.json.items as Array<Record<string, unknown>> | undefined;
    const row = items?.find((item) =>
      (item.registration as Record<string, unknown> | undefined)?.id === registrationId);
    const components = row?.components as Record<string, Record<string, unknown>> | undefined;
    return components?.issue_monitor?.state === 'running';
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
      && components?.issue_monitor?.state === 'running';
  });

  run(['delete', '--force', control]);
  run([
    'run', '--detach', '--name', control, '--network', network,
    '--publish', `127.0.0.1:${hostPort}:8080`,
    '--env', `AGENTOPS_DATABASE_URL=${databaseURL}`,
    '--env', `AGENTOPS_CONTROL_TOKEN=${controlToken}`,
    '--env', 'AGENTOPS_RECONCILIATION_INTERVAL=500ms',
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
      && components?.issue_monitor?.state === 'running';
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
    issue: 'mrbaron3/workflow#13',
    runtime: 'Apple Container',
    runtimeVersion: run(['--version'], { capture: true }),
    images: { runnerImage, controlImage, controlTestImage },
    checks: {
      standardOciControlBuild: 'passed',
      pinnedForwarderExtensionReady: 'passed',
      githubStubInternalOnly: 'passed',
      goRacePostgresIntegration: 'passed',
      designGateAtControlStartup: 'passed',
      postgresInternalOnly: 'passed',
      controlLoopbackOnly: 'passed',
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
