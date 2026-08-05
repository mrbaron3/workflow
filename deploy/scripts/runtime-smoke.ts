/**
 * Grounded Apple Container / OCI runtime smoke (issue #11 検証).
 *
 * Drives the container-runtime adapter end to end and grounds every AC-CISO-011 claim against a real
 * engine — nothing here is a mock. It fails closed: if preflight cannot confirm the runtime, if an
 * image is unavailable, or if any check does not hold, it prints the reason and exits non-zero rather
 * than reporting a fabricated pass. Every resource it creates carries a per-run-unique name and an
 * OS-assigned free port, and is torn down by ownership tracking, so a second (or `--keep`) run is
 * never harmed. `--keep` preserves the topology ONLY when every check passed — a failure always tears
 * down, so a partial topology is never left behind.
 *
 *   npx tsx deploy/scripts/runtime-smoke.ts                  # Apple Container (default)
 *   npx tsx deploy/scripts/runtime-smoke.ts --runtime=docker # OCI portability evidence
 *   npx tsx deploy/scripts/runtime-smoke.ts --keep           # keep topology up
 *
 * Steps: preflight (fail-closed) → capture the host loopback BASELINE (before anything of ours starts,
 * so a genuine leak can never be mistaken for a pre-existing service) → build standard OCI image →
 * create internal network → preflight app + official-postgres images (fail-closed BEFORE any topology
 * starts) → create persistent volume → start postgres (internal, volume) + control (loopback publish)
 * + runner (internal) → verify host publish surface (control reachable on 127.0.0.1; internal ports
 * refused; control refused on every non-loopback interface) → run the typecheck + runtime unit-test
 * graders inside the container from container-relative paths → drain/stop.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  AppleContainerRuntime,
  OciCliRuntime,
  agentopsTopology,
  anyHostProbe,
  assertPublishInvariant,
  hostExpectationForTopology,
  nonLoopbackAddresses,
  runPreflight,
  scanForHostPathDependencies,
  tcpLoopbackProbe,
  verifyHostPublishSurface,
  type ContainerRuntime,
  type ContainerSpec,
  type PreflightReport,
  type TopologySpec,
} from '../../apps/agentops/src/runtime/index.js';
import {
  AGENTOPS_PACKAGE_ROOT,
  REPOSITORY_ROOT,
  repositoryPath,
} from '../../apps/agentops/src/runtime/roots.js';

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

const REPO_ROOT = REPOSITORY_ROOT;
// Per-run-unique: the pid is unique among live processes, so names never collide with a concurrent run.
const NAME_PREFIX = `agentops-smoke-${process.pid}`;
const CONTROL_CONTAINER_PORT = 8080;
const POSTGRES_PORT = 5432;
const IMAGE_TAG = 'agentops-app:smoke';
const POSTGRES_PASSWORD = 'agentops-smoke-pw';
const DEPLOY_SCAN_TARGETS = [
  repositoryPath('deploy', 'Containerfile'),
  repositoryPath('deploy', 'playwright.dashboard.config.ts'),
  repositoryPath('deploy', 'vitest.config.ts'),
  ...fs.readdirSync(repositoryPath('deploy', 'scripts'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => repositoryPath('deploy', 'scripts', name)),
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** An OS-assigned free loopback port — genuinely unique, unlike a pid-derived guess. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('could not obtain a free port'))));
    });
  });
}

function parseArgs(argv: string[]): { runtime: string; keep: boolean; evidence: string; build: boolean } {
  const get = (flag: string, fallback: string): string => {
    const hit = argv.find((a) => a.startsWith(`${flag}=`));
    return hit ? hit.slice(flag.length + 1) : fallback;
  };
  return {
    runtime: get('--runtime', 'apple'),
    keep: argv.includes('--keep'),
    build: !argv.includes('--no-build'),
    evidence: get('--evidence', path.join(os.tmpdir(), `ciso-01-smoke-${process.pid}.json`)),
  };
}

function selectRuntime(kind: string): ContainerRuntime {
  if (kind === 'apple') return new AppleContainerRuntime();
  if (kind === 'docker' || kind === 'podman' || kind === 'nerdctl') return new OciCliRuntime(kind);
  throw new Error(`unknown --runtime=${kind} (expected apple|docker|podman|nerdctl)`);
}

/** Tracks resources created by THIS run so teardown removes only what it owns — never another run's. */
class Ownership {
  readonly networks: string[] = [];
  readonly volumes: string[] = [];
  readonly containers: string[] = [];

  createNetwork(runtime: ContainerRuntime, name: string): void {
    runtime.createNetwork({ name });
    this.networks.push(name);
  }

  createVolume(runtime: ContainerRuntime, name: string): void {
    runtime.createVolume({ name });
    this.volumes.push(name);
  }

  runContainer(runtime: ContainerRuntime, spec: ContainerSpec): void {
    this.containers.push(spec.name);
    runtime.runContainer(spec);
  }

  /** Registers a container name so teardown reaps it even if an inline removal is skipped or fails. */
  track(name: string): void {
    this.containers.push(name);
  }

  teardown(runtime: ContainerRuntime, log: (m: string) => void): void {
    for (const name of [...this.containers].reverse()) {
      try { runtime.stopContainer(name, { timeoutSeconds: 10 }); } catch { /* not running */ }
      try { runtime.removeContainer(name, { force: true }); } catch { /* already gone */ }
    }
    for (const name of [...this.volumes].reverse()) {
      try { runtime.removeVolume(name); } catch { /* already gone */ }
    }
    for (const name of [...this.networks].reverse()) {
      try { runtime.removeNetwork(name); } catch { /* already gone */ }
    }
    log('teardown complete (only this run\'s resources removed)');
  }
}

/** Polls a loopback port until it accepts a connection, or throws after `timeoutMs`. */
async function waitForLoopback(port: number, timeoutMs: number, label: string): Promise<void> {
  const probe = tcpLoopbackProbe(500);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(port)) return;
    await sleep(1000);
  }
  throw new Error(`${label} did not become reachable on 127.0.0.1:${port} within ${timeoutMs}ms`);
}

/** Polls postgres readiness inside its container, grounding "official image booted on its volume". */
async function waitForPostgres(runtime: ContainerRuntime, name: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = runtime.execInContainer(name, ['pg_isready', '-U', 'postgres']);
    if (result.status === 0 && result.stdout.includes('accepting connections')) return;
    await sleep(2000);
  }
  throw new Error(`postgres did not accept connections within ${timeoutMs}ms`);
}

/** Runs a throwaway container to confirm an image is available/runnable, then removes it. Throws on failure. */
function probeImage(runtime: ContainerRuntime, owned: Ownership, image: string, network: string, name: string): void {
  owned.track(name);
  try {
    runtime.runContainer({
      role: 'runner', name, image, network, publish: [], volumes: [], env: {}, command: ['true'],
    });
  } finally {
    try { runtime.removeContainer(name, { force: true }); } catch { /* nothing to remove */ }
  }
}

function writeEvidence(evidencePath: string, runtime: ContainerRuntime, ok: boolean, preflight: PreflightReport, steps: StepResult[]): void {
  fs.writeFileSync(evidencePath, JSON.stringify({
    runtime: runtime.name,
    ok,
    generatedFrom: 'deploy/scripts/runtime-smoke.ts',
    preflight,
    steps,
  }, null, 2));
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const log = (m: string): void => console.log(`[ciso-01-smoke] ${m}`);
  const runtime = selectRuntime(args.runtime);
  const owned = new Ownership();
  const steps: StepResult[] = [];
  const record = (name: string, ok: boolean, detail: string): boolean => {
    steps.push({ name, ok, detail });
    log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
    return ok;
  };

  const controlHostPort = await findFreePort();

  // 1. Preflight — fail closed. Nothing is built or started if the runtime is not confirmed.
  const preflight: PreflightReport = runPreflight(runtime, {
    minVersion: args.runtime === 'apple' ? '0.1.0' : undefined,
    requiredArchitecture: args.runtime === 'apple' ? 'arm64' : undefined,
    requireServiceRunning: true,
    lifecycle: { probeNamePrefix: `${NAME_PREFIX}-pf` },
  });
  if (!preflight.ok) {
    record('preflight', false, `runtime not confirmed: ${preflight.checks.filter((c) => c.required && !c.ok).map((c) => `${c.id}(${c.detail})`).join('; ')}`);
    writeEvidence(args.evidence, runtime, false, preflight, steps);
    log(`evidence: ${args.evidence}`);
    return 1;
  }
  record('preflight', true, `runtime confirmed via ${runtime.name}: ${preflight.checks.map((c) => c.id).join(', ')}`);

  // Static host-path scan of the build surface — the source that ships into the image must be Mac-neutral.
  const hostPathFindings = [
    ...scanForHostPathDependencies(AGENTOPS_PACKAGE_ROOT),
    ...scanForHostPathDependencies(REPOSITORY_ROOT, DEPLOY_SCAN_TARGETS),
  ];
  record('host-path-scan', hostPathFindings.length === 0,
    hostPathFindings.length === 0 ? 'no macOS home paths in the build/runtime surface'
      : `${hostPathFindings.length} hardcoded host path(s): ${hostPathFindings.map((f) => `${f.file}:${f.line}`).join(', ')}`);

  const topology = agentopsTopology({
    appImage: IMAGE_TAG,
    controlHostPort,
    controlContainerPort: CONTROL_CONTAINER_PORT,
    postgresPort: POSTGRES_PORT,
    postgresPassword: POSTGRES_PASSWORD,
    namePrefix: NAME_PREFIX,
  });

  // 2. Static publish invariant — assert the desired topology only publishes control's loopback port.
  try {
    assertPublishInvariant(topology);
    record('publish-invariant-static', true, 'only the control role publishes (127.0.0.1); named volumes only');
  } catch (error) {
    record('publish-invariant-static', false, error instanceof Error ? error.message : String(error));
    writeEvidence(args.evidence, runtime, false, preflight, steps);
    return 1;
  }

  // 3. Capture the loopback BASELINE now — BEFORE anything of ours starts. A negative-check port that
  //    is already reachable here is a pre-existing host service and is excluded; a port that becomes
  //    reachable only AFTER our topology starts is a genuine leak and stays asserted (fail-closed).
  const loopback = tcpLoopbackProbe(750);
  const negativeCandidates = [POSTGRES_PORT, CONTROL_CONTAINER_PORT];
  const negativePorts: number[] = [];
  for (const port of negativeCandidates) {
    if (await loopback(port)) log(`note: 127.0.0.1:${port} was already in use before start; excluding from the leak assertion`);
    else negativePorts.push(port);
  }
  record('leak-baseline', true, `ports asserted as must-not-leak: [${negativePorts.join(',')}]`);

  const postgresImage = topology.containers.find((c) => c.role === 'postgres')!.image;

  try {
    // 4. Build the standard OCI image.
    if (args.build) {
      runtime.buildImage({
        image: IMAGE_TAG,
        containerfile: repositoryPath('deploy', 'Containerfile'),
        contextDir: REPO_ROOT,
      });
      record('oci-build', true, `${IMAGE_TAG} built from deploy/Containerfile (standard OCI)`);
    } else {
      record('oci-build', true, 'skipped (--no-build)');
    }

    // 5. Internal network, then image preflight — confirm BOTH images run BEFORE starting any topology
    //    container, so a missing image is reported up front and never leaves a partial topology.
    owned.createNetwork(runtime, topology.network.name);
    try {
      probeImage(runtime, owned, IMAGE_TAG, topology.network.name, `${NAME_PREFIX}-imgprobe-app`);
      probeImage(runtime, owned, postgresImage, topology.network.name, `${NAME_PREFIX}-imgprobe-pg`);
      record('image-preflight', true, `${IMAGE_TAG} and ${postgresImage} are runnable`);
    } catch (error) {
      record('image-preflight', false, `image not runnable (no topology started): ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }

    // 6. Persistent volume, then start postgres (internal, volume) + control (loopback) + runner (internal).
    for (const volume of topology.volumes) owned.createVolume(runtime, volume.name);
    for (const container of topology.containers) owned.runContainer(runtime, container);
    record('containers-started', true, topology.containers.map((c) => `${c.role}:${c.name}`).join(', '));

    await waitForLoopback(controlHostPort, 60_000, 'control plane');
    await waitForPostgres(runtime, `${NAME_PREFIX}-postgres`, 90_000);
    record('services-ready', true, 'control listening on loopback; postgres accepting connections on its volume');

    // 7. Grounded host publish surface, using the pre-start baseline negative set and every interface.
    const addresses = nonLoopbackAddresses();
    const offLoopback = addresses.length ? anyHostProbe(addresses, 750) : undefined;
    const expectation = hostExpectationForTopology(topology, negativePorts);
    const surface = await verifyHostPublishSurface(expectation, loopback, offLoopback);
    record('publish-invariant-grounded', surface.ok,
      surface.ok
        ? `127.0.0.1:${controlHostPort} reachable; [${negativePorts.join(',')}] refused on 127.0.0.1; `
          + `control refused off-loopback ${addresses.length ? `(${addresses.join(', ')})` : '(no non-loopback interface observed)'}`
        : surface.violations.join('; '));

    // 8. Grounded Mac-absolute-path independence — the graders run inside the container from /app.
    const cwdProbe = runtime.execInContainer(`${NAME_PREFIX}-runner`, ['node', '-e', 'process.stdout.write(process.cwd())']);
    const cwd = cwdProbe.stdout.trim();
    record('container-cwd-neutral', cwd === '/app', `in-container cwd is ${cwd || '(empty)'} (expected /app, not a /Users path)`);

    const typecheck = runtime.execInContainer(`${NAME_PREFIX}-runner`, ['npm', 'run', 'typecheck']);
    record('grader-typecheck-in-container', typecheck.status === 0,
      typecheck.status === 0 ? 'npm run typecheck passed inside the container (container-relative paths)'
        : `typecheck exited ${typecheck.status ?? 'null'}: ${(typecheck.stdout + typecheck.stderr).slice(-400)}`);

    const unit = runtime.execInContainer(`${NAME_PREFIX}-runner`,
      ['npx', 'vitest', 'run', '--configLoader', 'runner',
        '--config', 'apps/agentops/vitest.config.ts',
        'apps/agentops/test/runtime-adapter.test.ts',
        'apps/agentops/test/runtime-preflight.test.ts',
        'apps/agentops/test/runtime-topology.test.ts',
        'apps/agentops/test/runtime-paths.test.ts']);
    record('grader-unit-tests-in-container', unit.status === 0,
      unit.status === 0 ? 'runtime unit tests passed inside the container (container-relative paths)'
        : `unit tests exited ${unit.status ?? 'null'}: ${(unit.stdout + unit.stderr).slice(-400)}`);
  } catch (error) {
    record('runtime-error', false, error instanceof Error ? error.message : String(error));
  } finally {
    // Fail-closed: `--keep` preserves the topology ONLY when every check passed. Any failure tears down,
    // so a partial or broken topology is never left behind.
    const anyFailed = steps.some((s) => !s.ok);
    if (args.keep && !anyFailed) log('--keep set and all checks passed; leaving this run\'s topology up');
    else owned.teardown(runtime, log);
  }

  const ok = steps.every((s) => s.ok);
  writeEvidence(args.evidence, runtime, ok, preflight, steps);
  log(`evidence: ${args.evidence}`);
  log(ok ? 'ALL CHECKS PASSED' : 'SMOKE FAILED');
  return ok ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(`[ciso-01-smoke] fatal: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
