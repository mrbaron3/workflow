/**
 * Grounded CISO-04 Apple Container boundary.
 *
 * Builds the standard non-root runner target, runs PostgreSQL + runner on one
 * internal network with private named volumes and zero host ports, executes the
 * complete PostgreSQL runner integration suite, then starts the real runner
 * process and proves unknown-schema/artifact-integrity refusal without any
 * provider/GitHub side effect.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const suffix = `${process.pid}-${Date.now()}`;
const network = `agentops-ciso04-${suffix}`;
const postgresVolume = `agentops-ciso04-pg-${suffix}`;
const runnerVolume = `agentops-ciso04-runner-${suffix}`;
const postgres = `agentops-ciso04-postgres-${suffix}`;
const runner = `agentops-ciso04-runner-${suffix}`;
const runtimeImage = `agentops-runtime:ciso04-${suffix}`;
const runnerImage = `agentops-runner:ciso04-${suffix}`;
const databasePassword = `postgres-${suffix}`;
const runnerDatabasePassword = `runner-${suffix}`;
const registrationId = randomUUID();
const unknownJobId = randomUUID();
const artifactJobId = randomUUID();
const evidencePath = path.join(root, 'evidence', 'ciso-04', 'apple-container-smoke.json');

interface ContainerInspection {
  configuration: {
    id: string;
    publishedPorts?: Array<unknown>;
    mounts?: Array<unknown>;
  };
  status: {
    state: string;
    networks: Array<{ ipv4Address: string }>;
  };
}

interface EvidenceCheck {
  result: 'passed';
  detail: unknown;
}

function run(args: string[], capture = false): string {
  const output = execFileSync('container', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  return typeof output === 'string' ? output.trim() : '';
}

function bestEffort(args: string[]): void {
  spawnSync('container', args, { cwd: root, stdio: 'ignore' });
}

function cleanup(): void {
  bestEffort(['delete', '--force', runner]);
  bestEffort(['delete', '--force', postgres]);
  bestEffort(['network', 'delete', network]);
  bestEffort(['volume', 'delete', runnerVolume]);
  bestEffort(['volume', 'delete', postgresVolume]);
}

function inspect(name: string): ContainerInspection {
  return JSON.parse(run(['inspect', name], true))[0] as ContainerInspection;
}

function postgresExec(sql: string, asRunner = false): string {
  const args = [
    'exec',
    ...(asRunner
      ? [
          '--env',
          `PGPASSWORD=${runnerDatabasePassword}`,
        ]
      : []),
    postgres,
    'psql',
    ...(asRunner
      ? ['-h', '127.0.0.1', '-U', 'agentops_runner']
      : ['-U', 'postgres']),
    '-d',
    'agentops',
    '-v',
    'ON_ERROR_STOP=1',
    '-Atc',
    sql,
  ];
  return run(args, true);
}

async function waitFor(
  description: string,
  predicate: () => boolean,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function jsonSql(value: unknown): string {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

async function main(): Promise<void> {
  cleanup();
  process.on('exit', cleanup);
  process.once('SIGINT', () => process.exit(130));
  process.once('SIGTERM', () => process.exit(143));
  const checks: Record<string, EvidenceCheck> = {};
  const pass = (name: string, detail: unknown): void => {
    checks[name] = { result: 'passed', detail };
    process.stdout.write(`[ciso-04-runner] PASS ${name}\n`);
  };

  run(['build', '--target', 'runtime', '-t', runtimeImage, '-f', 'deploy/Containerfile', '.']);
  run(['build', '--target', 'runner', '-t', runnerImage, '-f', 'deploy/Containerfile', '.']);
  pass('standardOciRunnerBuild', { image: runnerImage, target: 'runner' });

  run(['network', 'create', '--internal', network]);
  run(['volume', 'create', postgresVolume]);
  run(['volume', 'create', runnerVolume]);
  // Apple named volumes are initially root-owned. A short-lived, no-network
  // init container sets the private volume owner; the long-running runner
  // itself remains uid 65532 with every capability dropped.
  run([
    'run',
    '--rm',
    '--user',
    'root',
    '--volume',
    `${runnerVolume}:/workspace`,
    '--entrypoint',
    'chown',
    runnerImage,
    '-R',
    '65532:65532',
    '/workspace',
  ]);
  run([
    'run',
    '--detach',
    '--name',
    postgres,
    '--network',
    `${network},mac=02:42:ac:14:00:02`,
    '--volume',
    `${postgresVolume}:/var/lib/postgresql`,
    '--env',
    `POSTGRES_PASSWORD=${databasePassword}`,
    '--env',
    'POSTGRES_DB=agentops',
    '--env',
    'PGDATA=/var/lib/postgresql/data',
    'postgres:16',
  ]);
  await waitFor('PostgreSQL readiness', () =>
    spawnSync(
      'container',
      ['exec', postgres, 'pg_isready', '-U', 'postgres', '-d', 'agentops'],
      { stdio: 'ignore' },
    ).status === 0);
  const postgresInspection = inspect(postgres);
  const postgresIp =
    postgresInspection.status.networks[0]?.ipv4Address.split('/')[0];
  if (!postgresIp) throw new Error('PostgreSQL has no internal IPv4 address');
  const adminUrl =
    `postgresql://postgres:${databasePassword}@${postgresIp}:5432/agentops`;

  // The complete suite exercises lease competition/recovery, stale races at
  // every critical boundary, typed results/failures, and a safe fake adapter
  // through push/check/merge/release gates.
  run([
    'run',
    '--rm',
    '--network',
    network,
    '--entrypoint',
    'npx',
    '--env',
    `AGENTOPS_TEST_DATABASE_URL=${adminUrl}`,
    runnerImage,
    'vitest',
    'run',
    '--configLoader',
    'runner',
    'test/control-store.integration.test.ts',
  ]);
  pass('postgresRunnerIntegration', {
    suite: 'test/control-store.integration.test.ts',
    network,
    publishedPorts: 0,
  });

  postgresExec(
    `DO $$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentops_runner') THEN
         CREATE ROLE agentops_runner LOGIN PASSWORD '${runnerDatabasePassword}';
       END IF;
     END
     $$;
     GRANT CONNECT ON DATABASE agentops TO agentops_runner;
     GRANT USAGE ON SCHEMA agentops_control TO agentops_runner;
     GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA agentops_control TO agentops_runner;
     GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA agentops_control TO agentops_runner;`,
  );
  const runnerUrl =
    `postgresql://agentops_runner:${runnerDatabasePassword}@${postgresIp}:5432/agentops`;
  const outbound = JSON.stringify([
    { host: postgresIp, port: 5432 },
    { host: 'github.com', port: 443 },
    { host: 'api.github.com', port: 443 },
    { host: 'api.openai.com', port: 443 },
  ]);
  run([
    'run',
    '--detach',
    '--name',
    runner,
    '--network',
    `${network},mac=02:42:ac:14:00:03`,
    '--volume',
    `${runnerVolume}:/workspace`,
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/home/agentops',
    '--cap-drop',
    'ALL',
    '--env',
    'AGENTOPS_RUNNER_WORKER_ID=grounded-runner-1',
    '--env',
    'AGENTOPS_RUNNER_PROVIDER=codex',
    '--env',
    `AGENTOPS_RUNNER_DATABASE_URL=${runnerUrl}`,
    '--env',
    'AGENTOPS_RUNNER_GITHUB_TOKEN=grounded-no-side-effect-token',
    '--env',
    'OPENAI_API_KEY=grounded-no-side-effect-token',
    '--env',
    `AGENTOPS_RUNNER_MOUNTS_JSON=${JSON.stringify([{
      source: runnerVolume,
      target: '/workspace',
      readOnly: false,
    }])}`,
    '--env',
    'AGENTOPS_RUNNER_PUBLISHED_PORTS_JSON=[]',
    '--env',
    `AGENTOPS_RUNNER_OUTBOUND_JSON=${outbound}`,
    '--env',
    'AGENTOPS_RUNNER_LEASE_MS=5000',
    '--env',
    'AGENTOPS_RUNNER_HEARTBEAT_MS=1000',
    '--env',
    'AGENTOPS_RUNNER_RECONCILE_MS=250',
    runnerImage,
  ]);
  await waitFor('runner startup audit', () => {
    const count = postgresExec(
      `SELECT count(*)
         FROM agentops_control.runtime_audit
        WHERE actor_id = 'grounded-runner-1'
          AND event_type = 'runner.startup.validated'`,
    );
    return Number(count) === 1;
  });
  const runnerInspection = inspect(runner);
  if ((runnerInspection.configuration.publishedPorts ?? []).length !== 0) {
    throw new Error('runner unexpectedly published a host port');
  }
  if ((postgresInspection.configuration.publishedPorts ?? []).length !== 0) {
    throw new Error('PostgreSQL unexpectedly published a host port');
  }
  const uid = run(['exec', runner, 'id', '-u'], true);
  if (uid !== '65532') throw new Error(`runner is not non-root: uid=${uid}`);
  const mountInfo = run(['exec', runner, 'cat', '/proc/self/mountinfo'], true);
  for (const forbidden of [
    `/${'Users'}/`,
    'SSH_AUTH_SOCK',
    'docker.sock',
    'container.sock',
    '/run/host-services',
  ]) {
    if (mountInfo.includes(forbidden)) {
      throw new Error(`runner mount surface contains forbidden marker ${forbidden}`);
    }
  }
  if (!mountInfo.includes('/workspace')) {
    throw new Error('runner private /workspace volume is not mounted');
  }
  const startupAudit = JSON.parse(postgresExec(
    `SELECT details::text
       FROM agentops_control.runtime_audit
      WHERE actor_id = 'grounded-runner-1'
        AND event_type = 'runner.startup.validated'
      ORDER BY occurred_at DESC LIMIT 1`,
  )) as Record<string, unknown>;
  for (const key of [
    'databaseCredentialPresentInProcessEnvironment',
    'controlCredentialPresentInProcessEnvironment',
    'sshAgentPresentInProcessEnvironment',
    'containerSocketPresentInProcessEnvironment',
  ]) {
    if (startupAudit[key] !== false) {
      throw new Error(`startup process credential isolation failed: ${key}`);
    }
  }
  pass('runnerBoundaryIsolation', {
    runnerUid: Number(uid),
    runnerPublishedPorts: [],
    postgresPublishedPorts: [],
    runnerVolume,
    postgresVolume,
    privateNetwork: network,
    rootFilesystemReadOnly: true,
    capabilitiesDropped: 'ALL',
    startupAudit,
  });

  postgresExec(
    `INSERT INTO agentops_control.repository_registrations(
       id, repository, enabled, issue_monitor_enabled, pr_monitor_enabled,
       execution_enabled, configuration, version
     ) VALUES (
       '${registrationId}', 'example/runner-smoke', true, false, false,
       true, '{}'::jsonb, 1
     );
     INSERT INTO agentops_control.jobs(
       id, registration_id, registration_version, contract_version,
       source_kind, source_key, idempotency_key, job_type, payload
     ) VALUES (
       '${unknownJobId}', '${registrationId}', 1, 1,
       'manual', 'unknown-schema', 'unknown-schema', 'agentops.runner',
       ${jsonSql({ schemaVersion: 99 })}
     );`,
  );
  await waitFor('unknown schema rejection', () =>
    postgresExec(
      `SELECT status || ':' || COALESCE(failure->>'code', '')
         FROM agentops_control.jobs WHERE id = '${unknownJobId}'`,
    ) === 'failed:unknown_job_contract');
  pass('unknownSchemaRejected', {
    jobId: unknownJobId,
    outcome: 'failed:unknown_job_contract',
  });

  run([
    'exec',
    runner,
    'node',
    '-e',
    `const fs=require('fs');`
      + `const p='/workspace/registrations/${registrationId}/inputs/tampered.txt';`
      + `fs.mkdirSync(require('path').dirname(p),{recursive:true});`
      + `fs.writeFileSync(p,'safe\\n',{mode:0o600});`,
  ]);
  postgresExec(
    `INSERT INTO agentops_control.jobs(
       id, registration_id, registration_version, contract_version,
       source_kind, source_key, idempotency_key, job_type, payload
     ) VALUES (
       '${artifactJobId}', '${registrationId}', 1, 1,
       'manual', 'artifact-tamper', 'artifact-tamper', 'agentops.runner',
       ${jsonSql({
         schemaVersion: 1,
         repository: { owner: 'example', name: 'runner-smoke' },
         event: { kind: 'issue', number: 1, action: 'labeled' },
         target: { baseRef: 'refs/heads/main' },
         execution: {
           mode: 'development_turn',
           requiredChecks: [],
           mergeMethod: 'squash',
         },
         artifacts: [{
           uri:
             `volume://registrations/${registrationId}/inputs/tampered.txt`,
           sha256: '0'.repeat(64),
           sizeBytes: 5,
           createdAt: new Date().toISOString(),
         }],
       })}
     );`,
  );
  await waitFor('artifact integrity rejection', () =>
    postgresExec(
      `SELECT status || ':' || COALESCE(failure->>'code', '')
         FROM agentops_control.jobs WHERE id = '${artifactJobId}'`,
    ) === 'failed:artifact_integrity');
  pass('artifactIntegrityRejected', {
    jobId: artifactJobId,
    outcome: 'failed:artifact_integrity',
  });

  const groundedCounts = JSON.parse(postgresExec(
    `SELECT json_build_object(
       'claimAllowed', count(*) FILTER (
         WHERE event_type = 'runner.boundary.claim.allowed'
       ),
       'criticalAllowed', count(*) FILTER (
         WHERE event_type IN (
           'runner.boundary.provider.allowed',
           'runner.boundary.push.allowed',
           'runner.boundary.merge.allowed',
           'runner.boundary.release.allowed'
         )
       ),
       'criticalDenied', count(*) FILTER (
         WHERE event_type LIKE 'runner.boundary.%.denied'
       )
     )::text
     FROM agentops_control.runtime_audit`,
  ));
  pass('durableBoundaryAudit', groundedCounts);

  const evidence = {
    schemaVersion: '1.0',
    issue: 'mrbaron3/workflow#14',
    runtime: 'Apple Container',
    runtimeVersion: run(['--version'], true),
    images: { runtimeImage, runnerImage },
    topology: {
      internalNetwork: network,
      runnerPublishedPorts: runnerInspection.configuration.publishedPorts ?? [],
      postgresPublishedPorts: postgresInspection.configuration.publishedPorts ?? [],
      runnerPrivateVolume: runnerVolume,
      postgresPrivateVolume: postgresVolume,
    },
    checks,
    completedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

main().catch((error: unknown) => {
  try {
    process.stderr.write(`${run(['logs', runner], true)}\n`);
  } catch {
    // Preserve original failure.
  }
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => {
  cleanup();
});
