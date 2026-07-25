/**
 * Grounded Apple Container / OCI runtime smoke (issue #11 検証).
 *
 * Drives the container-runtime adapter end to end and grounds every AC-CISO-011 claim against a real
 * engine — nothing here is a mock. It fails closed: if preflight cannot confirm the runtime, or any
 * check does not hold, it prints the reason and exits non-zero rather than reporting a fabricated pass.
 *
 *   npx tsx scripts/runtime-smoke.ts                     # Apple Container (default)
 *   npx tsx scripts/runtime-smoke.ts --runtime=docker    # standard-OCI portability evidence
 *   npx tsx scripts/runtime-smoke.ts --keep              # leave containers up for inspection
 *
 * Steps: preflight (fail-closed) → build standard OCI image → assert publish invariant (static) →
 * create internal network + volume → start postgres (official image, internal, volume) + control
 * (loopback publish) + runner (internal) → verify host publish surface (control reachable, 5432 and
 * the control container port refused on the Mac) → run the typecheck grader inside the container from
 * container-relative paths → drain/stop. Emits a JSON evidence file for the PR.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AppleContainerRuntime,
  OciCliRuntime,
  agentopsTopology,
  assertPublishInvariant,
  hostExpectationForTopology,
  runPreflight,
  scanForHostPathDependencies,
  tcpLoopbackProbe,
  verifyHostPublishSurface,
  type ContainerRuntime,
  type PreflightReport,
  type TopologySpec,
} from '../src/runtime/index.js';

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

const REPO_ROOT = process.cwd();
const CONTROL_HOST_PORT = 17600;
const CONTROL_CONTAINER_PORT = 8080;
const POSTGRES_PORT = 5432;
const IMAGE_TAG = 'agentops-app:smoke';
const NAME_PREFIX = 'agentops-smoke';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
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

function teardown(runtime: ContainerRuntime, topology: TopologySpec, log: (m: string) => void): void {
  for (const container of topology.containers) {
    try { runtime.stopContainer(container.name, { timeoutSeconds: 10 }); } catch { /* not running */ }
    try { runtime.removeContainer(container.name, { force: true }); } catch { /* already gone */ }
  }
  for (const volume of topology.volumes) {
    try { runtime.removeVolume(volume.name); } catch { /* already gone */ }
  }
  try { runtime.removeNetwork(topology.network.name); } catch { /* already gone */ }
  log('teardown complete');
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const log = (m: string): void => console.log(`[ciso-01-smoke] ${m}`);
  const runtime = selectRuntime(args.runtime);
  const steps: StepResult[] = [];
  const record = (name: string, ok: boolean, detail: string): boolean => {
    steps.push({ name, ok, detail });
    log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
    return ok;
  };

  // 1. Preflight — fail closed. No image is built, no container is started, if the runtime is not confirmed.
  const preflight: PreflightReport = runPreflight(runtime, {
    minVersion: args.runtime === 'apple' ? '0.1.0' : undefined,
    requiredArchitecture: args.runtime === 'apple' ? 'arm64' : undefined,
    requireServiceRunning: true,
    lifecycle: { probeNamePrefix: `${NAME_PREFIX}-pf` },
  });
  if (!preflight.ok) {
    record('preflight', false, `runtime not confirmed: ${preflight.checks.filter((c) => c.required && !c.ok).map((c) => `${c.id}(${c.detail})`).join('; ')}`);
    fs.writeFileSync(args.evidence, JSON.stringify({ runtime: runtime.name, ok: false, preflight, steps }, null, 2));
    log(`evidence: ${args.evidence}`);
    return 1;
  }
  record('preflight', true, `runtime confirmed via ${runtime.name}: ${preflight.checks.map((c) => c.id).join(', ')}`);

  // Static host-path scan of the build surface — the source that ships into the image must be Mac-neutral.
  const hostPathFindings = scanForHostPathDependencies(REPO_ROOT);
  record('host-path-scan', hostPathFindings.length === 0,
    hostPathFindings.length === 0 ? 'no macOS home paths in the build/runtime surface'
      : `${hostPathFindings.length} hardcoded host path(s): ${hostPathFindings.map((f) => `${f.file}:${f.line}`).join(', ')}`);

  const topology = agentopsTopology({
    appImage: IMAGE_TAG,
    controlHostPort: CONTROL_HOST_PORT,
    controlContainerPort: CONTROL_CONTAINER_PORT,
    postgresPort: POSTGRES_PORT,
    namePrefix: NAME_PREFIX,
  });

  // 2. Static publish invariant — assert the desired topology only publishes control's loopback port.
  try {
    assertPublishInvariant(topology);
    record('publish-invariant-static', true, 'only the control role publishes, and only to 127.0.0.1');
  } catch (error) {
    record('publish-invariant-static', false, error instanceof Error ? error.message : String(error));
    fs.writeFileSync(args.evidence, JSON.stringify({ runtime: runtime.name, ok: false, preflight, steps }, null, 2));
    return 1;
  }

  try {
    // 3. Build the standard OCI image.
    if (args.build) {
      runtime.buildImage({ image: IMAGE_TAG, containerfile: 'deploy/Containerfile', contextDir: REPO_ROOT });
      record('oci-build', true, `${IMAGE_TAG} built from deploy/Containerfile (standard OCI)`);
    } else {
      record('oci-build', true, 'skipped (--no-build)');
    }

    // 4. Internal network + persistent volume.
    runtime.createNetwork(topology.network);
    for (const volume of topology.volumes) runtime.createVolume(volume);
    record('network-volume', true, `network ${topology.network.name} + volume(s) ${topology.volumes.map((v) => v.name).join(', ')} created`);

    // 5. Start postgres (internal, volume) + control (loopback publish) + runner (internal).
    for (const container of topology.containers) runtime.runContainer(container);
    record('containers-started', true, topology.containers.map((c) => `${c.role}:${c.name}`).join(', '));

    await waitForLoopback(CONTROL_HOST_PORT, 60_000, 'control plane');
    await waitForPostgres(runtime, `${NAME_PREFIX}-postgres`, 90_000);
    record('services-ready', true, 'control listening on loopback; postgres accepting connections on its volume');

    // 6. Grounded host publish surface — control reachable; postgres 5432 and control container port refused on the Mac.
    const expectation = hostExpectationForTopology(topology, [POSTGRES_PORT, CONTROL_CONTAINER_PORT]);
    const surface = await verifyHostPublishSurface(expectation, tcpLoopbackProbe(750));
    record('publish-invariant-grounded', surface.ok,
      surface.ok ? `127.0.0.1:${CONTROL_HOST_PORT} reachable; ${POSTGRES_PORT} and ${CONTROL_CONTAINER_PORT} refused on the Mac`
        : surface.violations.join('; '));

    // 7. Grounded Mac-absolute-path independence — typecheck grader runs inside the container from /app.
    const cwdProbe = runtime.execInContainer(`${NAME_PREFIX}-runner`, ['node', '-e', 'process.stdout.write(process.cwd())']);
    const cwd = cwdProbe.stdout.trim();
    record('container-cwd-neutral', cwd === '/app', `in-container cwd is ${cwd || '(empty)'} (expected /app, not a /Users path)`);

    const grader = runtime.execInContainer(`${NAME_PREFIX}-runner`, ['npm', 'run', 'typecheck']);
    record('grader-in-container', grader.status === 0,
      grader.status === 0 ? 'npm run typecheck passed inside the container (container-relative paths)'
        : `typecheck exited ${grader.status ?? 'null'}: ${(grader.stdout + grader.stderr).slice(-400)}`);
  } catch (error) {
    record('runtime-error', false, error instanceof Error ? error.message : String(error));
  } finally {
    if (!args.keep) teardown(runtime, topology, log);
    else log('--keep set; leaving topology up');
  }

  const ok = steps.every((s) => s.ok);
  fs.writeFileSync(args.evidence, JSON.stringify({
    runtime: runtime.name,
    ok,
    generatedFrom: 'scripts/runtime-smoke.ts',
    preflight,
    steps,
  }, null, 2));
  log(`evidence: ${args.evidence}`);
  log(ok ? 'ALL CHECKS PASSED' : 'SMOKE FAILED');
  return ok ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(`[ciso-01-smoke] fatal: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
