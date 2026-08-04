/**
 * Grounded CISO-02 PostgreSQL validation on the CISO-01 runtime boundary.
 *
 * Builds the standard OCI app, runs PostgreSQL and the test runner on an
 * internal-only Apple Container network, executes the integration suite, then
 * replaces the PostgreSQL container while retaining its named volume and proves
 * the migrated schema/data survived.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AppleContainerRuntime,
  OFFICIAL_POSTGRES_IMAGE,
  runPreflight,
  spawnSyncRunner,
  type ContainerRuntime,
  type ContainerSpec,
} from '../src/runtime/index.js';
import { CONTROL_SCHEMA_VERSION } from '../src/control-store/index.js';

interface Step {
  name: string;
  ok: boolean;
  detail: string;
}

const prefix = `agentops-ciso02-${process.pid}`;
const network = `${prefix}-internal`;
const volume = `${prefix}-postgres-data`;
const postgresName = `${prefix}-postgres`;
const runnerName = `${prefix}-runner`;
const appImage = 'agentops-app:ciso02-smoke';
const password = 'agentops-ciso02-smoke';
const evidence = process.argv.find((argument) => argument.startsWith('--evidence='))?.slice(11)
  ?? path.join(os.tmpdir(), `ciso-02-postgres-smoke-${process.pid}.json`);
const skipBuild = process.argv.includes('--no-build');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPostgres(
  runtime: ContainerRuntime,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = runtime.execInContainer(postgresName, [
      'pg_isready',
      '-U',
      'postgres',
      '-d',
      'agentops',
    ]);
    if (result.status === 0 && result.stdout.includes('accepting connections')) return;
    await sleep(1_000);
  }
  throw new Error(`PostgreSQL did not become ready within ${timeoutMs}ms`);
}

function postgresSpec(): ContainerSpec {
  return {
    role: 'postgres',
    name: postgresName,
    image: OFFICIAL_POSTGRES_IMAGE,
    network,
    publish: [],
    volumes: [{ volume, mountPath: '/var/lib/postgresql', readOnly: false }],
    env: {
      POSTGRES_PASSWORD: password,
      POSTGRES_DB: 'agentops',
      PGDATA: '/var/lib/postgresql/18/docker',
    },
  };
}

function removeContainer(runtime: ContainerRuntime, name: string): void {
  try {
    runtime.stopContainer(name, { timeoutSeconds: 10 });
  } catch {
    // The container may already be stopped.
  }
  try {
    runtime.removeContainer(name, { force: true });
  } catch {
    // The container may already be absent.
  }
}

function appleContainerIpv4(name: string): string {
  const inspected = spawnSyncRunner('container', ['inspect', name]);
  if (inspected.status !== 0) {
    throw new Error(`cannot inspect ${name}: ${inspected.stdout}${inspected.stderr}`);
  }
  const rows = JSON.parse(inspected.stdout) as Array<{
    status?: { networks?: Array<{ ipv4Address?: string }> };
  }>;
  const address = rows[0]?.status?.networks?.[0]?.ipv4Address?.split('/')[0];
  if (!address) throw new Error(`container ${name} has no internal IPv4 address`);
  return address;
}

async function main(): Promise<number> {
  const runtime = new AppleContainerRuntime();
  const steps: Step[] = [];
  const record = (name: string, ok: boolean, detail: string): void => {
    steps.push({ name, ok, detail });
    console.log(`[ciso-02-postgres] ${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
  };
  let networkCreated = false;
  let volumeCreated = false;
  try {
    const preflight = runPreflight(runtime, {
      minVersion: '0.1.0',
      requiredArchitecture: 'arm64',
      requireServiceRunning: true,
      lifecycle: { probeNamePrefix: `${prefix}-preflight` },
    });
    if (!preflight.ok) {
      record(
        'apple-container-preflight',
        false,
        preflight.checks.filter((check) => check.required && !check.ok)
          .map((check) => `${check.id}: ${check.detail}`).join('; '),
      );
      return 1;
    }
    record('apple-container-preflight', true, 'Apple Container service and lifecycle are available');

    if (!skipBuild) {
      runtime.buildImage({
        image: appImage,
        containerfile: 'deploy/Containerfile',
        contextDir: process.cwd(),
        // The Containerfile's final stage is the Go control image. This smoke
        // needs the TypeScript test runner and must never depend on stage order.
        target: 'runtime',
      });
    }
    record('standard-oci-build', true, skipBuild ? 'reused existing image' : 'built deploy/Containerfile');

    runtime.createNetwork({ name: network });
    networkCreated = true;
    runtime.createVolume({ name: volume });
    volumeCreated = true;
    runtime.runContainer(postgresSpec());
    await waitForPostgres(runtime);
    const postgresIp = appleContainerIpv4(postgresName);

    runtime.runContainer({
      role: 'runner',
      name: runnerName,
      image: appImage,
      network,
      publish: [],
      volumes: [],
      env: {
        // Apple Container 1.1 currently has intermittent container-name DNS
        // resolution. Use the inspected private-network address for a grounded
        // DB connection; the database still has no host publication.
        AGENTOPS_TEST_DATABASE_URL: `postgresql://postgres:${password}@${postgresIp}:5432/agentops`,
      },
      command: ['node', '-e', 'setInterval(() => {}, 1 << 30)'],
    });
    record(
      'internal-topology',
      true,
      'PostgreSQL and runner started on a private network with zero published ports',
    );

    const integration = runtime.execInContainer(runnerName, [
      'npx',
      'vitest',
      'run',
      '--configLoader',
      'runner',
      'test/control-store.integration.test.ts',
    ]);
    record(
      'postgres-integration',
      integration.status === 0,
      integration.status === 0
        ? 'all PostgreSQL integration tests passed inside the OCI runner'
        : `exit ${integration.status ?? 'null'}: ${(integration.stdout + integration.stderr).slice(-1500)}`,
    );
    if (integration.status !== 0) return 1;

    const before = runtime.execInContainer(postgresName, [
      'psql',
      '-U',
      'postgres',
      '-d',
      'agentops',
      '-Atc',
      'SELECT count(*) FROM agentops_control.jobs',
    ]);
    if (before.status !== 0 || Number(before.stdout.trim()) < 1) {
      record('persistent-volume-before-restart', false, before.stdout + before.stderr);
      return 1;
    }
    record(
      'persistent-volume-before-restart',
      true,
      `${before.stdout.trim()} durable job record(s) present`,
    );

    removeContainer(runtime, postgresName);
    runtime.runContainer(postgresSpec());
    await waitForPostgres(runtime);
    const after = runtime.execInContainer(postgresName, [
      'psql',
      '-U',
      'postgres',
      '-d',
      'agentops',
      '-Atc',
      `SELECT
         (SELECT max(version) FROM agentops_control.schema_migrations)::text
         || ':'
         || (SELECT count(*) FROM agentops_control.jobs)::text`,
    ]);
    const recovered = after.status === 0
      && new RegExp(`^${CONTROL_SCHEMA_VERSION}:[1-9][0-9]*$`).test(after.stdout.trim());
    record(
      'persistent-volume-recovery',
      recovered,
      recovered
        ? `container replaced; schema/data recovered as ${after.stdout.trim()}`
        : `recovery query failed: ${after.stdout}${after.stderr}`,
    );
    return recovered ? 0 : 1;
  } catch (error) {
    record('runtime-error', false, error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    removeContainer(runtime, runnerName);
    removeContainer(runtime, postgresName);
    if (volumeCreated) {
      try {
        runtime.removeVolume(volume);
      } catch {
        // Evidence has already recorded any substantive failure.
      }
    }
    if (networkCreated) {
      try {
        runtime.removeNetwork(network);
      } catch {
        // Evidence has already recorded any substantive failure.
      }
    }
    fs.mkdirSync(path.dirname(evidence), { recursive: true });
    fs.writeFileSync(evidence, JSON.stringify({
      generatedAt: new Date().toISOString(),
      generatedFrom: 'scripts/ciso02-postgres-smoke.ts',
      runtime: runtime.name,
      ok: steps.length > 0 && steps.every((step) => step.ok),
      steps,
    }, null, 2));
    console.log(`[ciso-02-postgres] evidence: ${evidence}`);
  }
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
