/**
 * Fail-closed runtime preflight (issue #11: 「volume/network/image/runtime capability の不足を
 * 起動前に fail closed で報告する」).
 *
 * `runPreflight` produces a structured verdict, never a fabricated pass. It always runs the cheap
 * non-mutating capability checks (CLI present, version, architecture, service). When a caller opts
 * into `lifecycle`, it additionally exercises the real host boundary — creating and deleting a probe
 * network and volume, and (given a probe image) running a throwaway container — so "the runtime can
 * actually do this" is grounded, not assumed. A failed *required* check makes the whole report
 * `ok: false`; once a prerequisite fails, later checks are recorded as "not evaluated" rather than
 * being silently skipped or optimistically passed.
 */

import type { ContainerRuntime } from './adapter.js';
import type {
  CapabilityReport,
  ContainerArchitecture,
  PreflightCheck,
  PreflightCheckId,
  PreflightReport,
} from './schema.js';

/** Optional mutating probes; when present, preflight touches the real runtime. */
export interface PreflightLifecycleProbe {
  /** Image to run for the `oci_image_run` check. Absent = that check is not evaluated. */
  probeImage?: string;
  /** Command to run in the probe image. Defaults to a trivial no-op. */
  probeCommand?: string[];
  /** Prefix for the throwaway network/volume/container names. */
  probeNamePrefix?: string;
}

export interface PreflightRequirements {
  /** Minimum acceptable runtime version (semver). Absent = any version. */
  minVersion?: string;
  /** Required image/host architecture. Apple Container ⇒ 'arm64'. Absent = any. */
  requiredArchitecture?: ContainerArchitecture;
  /** Whether the runtime's system service must already be running. */
  requireServiceRunning: boolean;
  /** Opt-in mutating host-boundary probes. Absent = capability checks only. */
  lifecycle?: PreflightLifecycleProbe;
}

/** Compares two `x.y.z` semvers. Returns -1, 0, or 1. Missing/NaN components read as 0. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] => v.split('.').map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function check(id: PreflightCheckId, required: boolean, ok: boolean, detail: string): PreflightCheck {
  return { id, required, ok, detail };
}

function notEvaluated(id: PreflightCheckId, required: boolean): PreflightCheck {
  return check(id, required, false, 'not evaluated (a prerequisite check failed)');
}

/** Runs one mutating probe, converting any thrown `RuntimeCommandError` into a fail-closed check. */
function probe(id: PreflightCheckId, run: () => void): PreflightCheck {
  try {
    run();
    return check(id, true, true, 'ok');
  } catch (error) {
    return check(id, true, false, error instanceof Error ? error.message : String(error));
  }
}

function capabilityChecks(
  capability: CapabilityReport,
  requirements: PreflightRequirements,
): PreflightCheck[] {
  const present = check(
    'cli_present',
    true,
    capability.available,
    capability.available ? capability.detail : capability.detail,
  );
  if (!capability.available) {
    return [
      present,
      notEvaluated('cli_version', requirements.minVersion !== undefined),
      notEvaluated('architecture', requirements.requiredArchitecture !== undefined),
      notEvaluated('service_running', requirements.requireServiceRunning),
    ];
  }

  const versionRequired = requirements.minVersion !== undefined;
  const versionOk = requirements.minVersion === undefined
    ? true
    : capability.version !== null && compareSemver(capability.version, requirements.minVersion) >= 0;
  const versionDetail = requirements.minVersion === undefined
    ? 'no minimum version required'
    : capability.version === null
      ? 'runtime version could not be determined'
      : `${capability.version} (minimum ${requirements.minVersion})`;

  const archRequired = requirements.requiredArchitecture !== undefined;
  const archOk = requirements.requiredArchitecture === undefined
    ? true
    : capability.architecture === requirements.requiredArchitecture;
  const archDetail = requirements.requiredArchitecture === undefined
    ? 'no architecture requirement'
    : `${capability.architecture ?? 'unknown'} (required ${requirements.requiredArchitecture})`;

  const serviceOk = requirements.requireServiceRunning ? capability.serviceRunning : true;

  return [
    present,
    check('cli_version', versionRequired, versionOk, versionDetail),
    check('architecture', archRequired, archOk, archDetail),
    check('service_running', requirements.requireServiceRunning, serviceOk, capability.detail),
  ];
}

function lifecycleChecks(
  runtime: ContainerRuntime,
  lifecycle: PreflightLifecycleProbe,
): PreflightCheck[] {
  const prefix = lifecycle.probeNamePrefix ?? 'agentops-preflight';
  const networkName = `${prefix}-net`;
  const volumeName = `${prefix}-vol`;

  const networkCheck = probe('network_lifecycle', () => {
    runtime.createNetwork({ name: networkName });
    runtime.removeNetwork(networkName);
  });
  const volumeCheck = probe('volume_lifecycle', () => {
    runtime.createVolume({ name: volumeName });
    runtime.removeVolume(volumeName);
  });

  const checks = [networkCheck, volumeCheck];
  if (lifecycle.probeImage === undefined) return checks;

  const containerName = `${prefix}-run`;
  const runCheck = probe('oci_image_run', () => {
    runtime.createNetwork({ name: networkName });
    try {
      runtime.runContainer({
        role: 'runner',
        name: containerName,
        image: lifecycle.probeImage as string,
        network: networkName,
        publish: [],
        volumes: [],
        env: {},
        command: lifecycle.probeCommand ?? ['true'],
      });
    } finally {
      // Best-effort cleanup so a probe never leaks a container/network into the operator's runtime.
      try { runtime.removeContainer(containerName, { force: true }); } catch { /* already gone */ }
      try { runtime.removeNetwork(networkName); } catch { /* already gone */ }
    }
  });
  checks.push(runCheck);
  return checks;
}

/**
 * Runs preflight and returns a fail-closed report. `ok` is true only when every *required* check
 * passed. This function never throws for a runtime deficiency — an absent CLI, a stopped service, or
 * a failed probe all become a structured `ok: false` report the caller escalates on.
 */
export function runPreflight(
  runtime: ContainerRuntime,
  requirements: PreflightRequirements,
): PreflightReport {
  const capability = runtime.capability();
  const checks = capabilityChecks(capability, requirements);

  const requiredCapabilityOk = checks.filter((c) => c.required).every((c) => c.ok);
  if (requirements.lifecycle) {
    // Only touch the real runtime when the capability prerequisites already hold; otherwise the
    // mutating probes would fail for the same reason and add noise, so record them as not-evaluated.
    if (requiredCapabilityOk) {
      checks.push(...lifecycleChecks(runtime, requirements.lifecycle));
    } else {
      checks.push(notEvaluated('network_lifecycle', true));
      checks.push(notEvaluated('volume_lifecycle', true));
      if (requirements.lifecycle.probeImage !== undefined) {
        checks.push(notEvaluated('oci_image_run', true));
      }
    }
  }

  const ok = checks.filter((c) => c.required).every((c) => c.ok);
  return { runtime: capability.runtime, ok, checks };
}
