/**
 * The Apple Container adapter — the ONE place Apple Container / macOS specifics live (AC-CISO-011).
 *
 * Everything Apple-specific is confined here: the `container` binary name, its `network delete` /
 * `volume delete` dialect, its `--version` string shape, its `system status` service probe, and the
 * Apple-Silicon-only architecture. The core and every other context import only the `ContainerRuntime`
 * port, so no macOS/launchd/Apple-Container knowledge leaks upward.
 */

import { CliContainerRuntime, type CliDialect, type CommandRunner } from './adapter.js';
import type { CapabilityReport, ContainerArchitecture } from './schema.js';

/** Apple Container runs Linux guests on an Apple-Silicon host; process.arch reflects the Mac CPU. */
export function hostArchitecture(arch: NodeJS.Architecture = process.arch): ContainerArchitecture | null {
  switch (arch) {
    case 'arm64':
      return 'arm64';
    case 'x64':
      return 'amd64';
    default:
      return null;
  }
}

/** `container --version` prints e.g. "container CLI version 0.1.0 (build …)"; pull out the semver. */
export function parseContainerVersion(stdout: string): string | null {
  const match = stdout.match(/(\d+)\.\d+\.\d+/);
  return match ? match[0] : null;
}

export class AppleContainerRuntime extends CliContainerRuntime {
  readonly name = 'apple-container';
  protected readonly binary = 'container';
  protected readonly dialect: CliDialect = {
    networkRemoveVerb: 'delete',
    volumeRemoveVerb: 'delete',
    stopTimeoutFlag: '--time',
  };

  constructor(run?: CommandRunner) {
    super(run);
  }

  /**
   * Non-mutating capability probe. Never throws: an absent or non-runnable CLI yields
   * `available: false` with the reason, so preflight gets a structured refusal, not an exception.
   */
  capability(): CapabilityReport {
    const version = this.tryExec(['--version']);
    if (version.status !== 0) {
      return {
        runtime: this.name,
        available: false,
        version: null,
        architecture: null,
        serviceRunning: false,
        detail: 'Apple Container CLI (`container`) not found or not runnable',
      };
    }
    const service = this.tryExec(['system', 'status']);
    const serviceRunning = service.status === 0;
    return {
      runtime: this.name,
      available: true,
      version: parseContainerVersion(version.stdout),
      architecture: hostArchitecture(),
      serviceRunning,
      detail: serviceRunning
        ? 'Apple Container CLI present and system service running'
        : 'Apple Container CLI present but system service is not running (`container system start`)',
    };
  }
}
