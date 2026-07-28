import { describe, it, expect, vi } from 'vitest';
import type { CommandResult, ContainerRuntime } from '../src/runtime/adapter.js';
import { RuntimeCommandError } from '../src/runtime/adapter.js';
import { compareSemver, runPreflight, type PreflightRequirements } from '../src/runtime/preflight.js';
import type { CapabilityReport, PreflightCheckId } from '../src/runtime/schema.js';

function capability(overrides: Partial<CapabilityReport> = {}): CapabilityReport {
  return {
    runtime: 'apple-container',
    available: true,
    version: '0.3.1',
    architecture: 'arm64',
    serviceRunning: true,
    detail: 'ok',
    ...overrides,
  };
}

function fakeRuntime(
  cap: CapabilityReport,
  ops: Partial<Pick<ContainerRuntime,
    'createNetwork' | 'removeNetwork' | 'createVolume' | 'removeVolume' | 'runContainer' | 'removeContainer'>> = {},
): ContainerRuntime {
  const noop = (): void => {};
  const okResult: CommandResult = { status: 0, stdout: '', stderr: '' };
  return {
    name: cap.runtime,
    capability: () => cap,
    buildImage: noop,
    createNetwork: ops.createNetwork ?? noop,
    removeNetwork: ops.removeNetwork ?? noop,
    createVolume: ops.createVolume ?? noop,
    removeVolume: ops.removeVolume ?? noop,
    runContainer: ops.runContainer ?? (() => 'container-id'),
    stopContainer: noop,
    removeContainer: ops.removeContainer ?? noop,
    execInContainer: () => okResult,
  };
}

const strict: PreflightRequirements = {
  minVersion: '0.1.0',
  requiredArchitecture: 'arm64',
  requireServiceRunning: true,
};

function checkById(checks: { id: PreflightCheckId; ok: boolean }[], id: PreflightCheckId): boolean {
  return checks.find((c) => c.id === id)?.ok ?? false;
}

describe('runtime preflight — fail-closed capability gate', () => {
  it('compares semantic versions', () => {
    expect(compareSemver('0.3.1', '0.1.0')).toBe(1);
    expect(compareSemver('0.1.0', '0.1.0')).toBe(0);
    expect(compareSemver('0.0.9', '0.1.0')).toBe(-1);
    expect(compareSemver('1.2', '1.2.0')).toBe(0);
  });

  it('passes only when every required capability check holds', () => {
    const report = runPreflight(fakeRuntime(capability()), strict);
    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  it('AC-CISO-011 fails closed with a structured report when the CLI is absent (no exception, no fabricated pass)', () => {
    const report = runPreflight(fakeRuntime(capability({ available: false, version: null, architecture: null, serviceRunning: false, detail: 'CLI not found' })), strict);
    expect(report.ok).toBe(false);
    expect(checkById(report.checks, 'cli_present')).toBe(false);
    expect(report.checks.filter((c) => c.id !== 'cli_present').every((c) => c.detail.includes('not evaluated'))).toBe(true);
  });

  it('fails when the version is below the minimum', () => {
    const report = runPreflight(fakeRuntime(capability({ version: '0.0.9' })), strict);
    expect(report.ok).toBe(false);
    expect(checkById(report.checks, 'cli_version')).toBe(false);
  });

  it('fails when the architecture does not match (Apple Container is arm64-only)', () => {
    const report = runPreflight(fakeRuntime(capability({ architecture: 'amd64' })), strict);
    expect(report.ok).toBe(false);
    expect(checkById(report.checks, 'architecture')).toBe(false);
  });

  it('fails when the required service is not running', () => {
    const report = runPreflight(fakeRuntime(capability({ serviceRunning: false })), strict);
    expect(report.ok).toBe(false);
    expect(checkById(report.checks, 'service_running')).toBe(false);
  });
});

describe('runtime preflight — grounded lifecycle probes', () => {
  it('exercises the real host boundary and passes when network/volume/image probes succeed', () => {
    const createNetwork = vi.fn();
    const removeNetwork = vi.fn();
    const createVolume = vi.fn();
    const removeVolume = vi.fn();
    const runContainer = vi.fn(() => 'id');
    const removeContainer = vi.fn();
    const report = runPreflight(
      fakeRuntime(capability(), { createNetwork, removeNetwork, createVolume, removeVolume, runContainer, removeContainer }),
      { ...strict, lifecycle: { probeImage: 'app:dev', probeNamePrefix: 'pf' } },
    );
    expect(report.ok).toBe(true);
    expect(checkById(report.checks, 'network_lifecycle')).toBe(true);
    expect(checkById(report.checks, 'volume_lifecycle')).toBe(true);
    expect(checkById(report.checks, 'oci_image_run')).toBe(true);
    expect(createNetwork).toHaveBeenCalled();
    expect(removeNetwork).toHaveBeenCalled();
    expect(runContainer).toHaveBeenCalled();
    expect(removeContainer).toHaveBeenCalledWith('pf-run', { force: true });
  });

  it('converts a failed probe into a fail-closed check rather than throwing', () => {
    const report = runPreflight(
      fakeRuntime(capability(), {
        createVolume: () => { throw new RuntimeCommandError('container', ['volume', 'create', 'pf-vol'], { status: 1, stdout: '', stderr: 'disk full' }); },
      }),
      { ...strict, lifecycle: { probeNamePrefix: 'pf' } },
    );
    expect(report.ok).toBe(false);
    expect(checkById(report.checks, 'network_lifecycle')).toBe(true);
    const volumeCheck = report.checks.find((c) => c.id === 'volume_lifecycle');
    expect(volumeCheck?.ok).toBe(false);
    expect(volumeCheck?.detail).toContain('disk full');
  });

  it('does not touch the runtime when the capability prerequisites already failed', () => {
    const createNetwork = vi.fn();
    const report = runPreflight(
      fakeRuntime(capability({ serviceRunning: false }), { createNetwork }),
      { ...strict, lifecycle: { probeImage: 'app:dev' } },
    );
    expect(report.ok).toBe(false);
    expect(createNetwork).not.toHaveBeenCalled();
    expect(report.checks.find((c) => c.id === 'network_lifecycle')?.detail).toContain('not evaluated');
    expect(report.checks.some((c) => c.id === 'oci_image_run')).toBe(true);
  });
});
