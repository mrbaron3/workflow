/**
 * A generic OCI CLI adapter (docker / podman / nerdctl-compatible).
 *
 * Its purpose is twofold. First, it is grounded proof that the `ContainerRuntime` port is genuinely
 * runtime-neutral — a second concrete adapter that shares the neutral verbs and differs only in its
 * dialect and probes, which is what AC-CISO-011's "runtime adapter 以外の core に固有処理を持ち込まない"
 * demands. Second, because the application image is standard OCI, this adapter can build and run the
 * exact same Containerfile under docker, producing portability evidence without Apple Container present.
 *
 * It carries no macOS/Apple specifics; the Apple-only knowledge lives solely in apple-container.ts.
 */

import { CliContainerRuntime, type CliDialect, type CommandRunner } from './adapter.js';
import type { CapabilityReport, ContainerArchitecture } from './schema.js';

/** Maps a docker/OCI `info` architecture token (aarch64, x86_64, …) to our contract enum. */
export function normalizeOciArchitecture(raw: string): ContainerArchitecture | null {
  const token = raw.trim().toLowerCase();
  if (token === 'aarch64' || token === 'arm64') return 'arm64';
  if (token === 'x86_64' || token === 'amd64') return 'amd64';
  return null;
}

export class OciCliRuntime extends CliContainerRuntime {
  readonly name: string;
  protected readonly binary: string;
  protected readonly dialect: CliDialect = {
    networkRemoveVerb: 'rm',
    volumeRemoveVerb: 'rm',
    stopTimeoutFlag: '--time',
  };

  constructor(binary: string = 'docker', run?: CommandRunner) {
    super(run);
    this.binary = binary;
    this.name = `oci-cli:${binary}`;
  }

  capability(): CapabilityReport {
    const serverVersion = this.tryExec(['version', '--format', '{{.Server.Version}}']);
    const daemonReachable = serverVersion.status === 0 && serverVersion.stdout.trim() !== '';
    if (!daemonReachable) {
      // Distinguish "CLI absent" from "daemon down" so the operator gets an actionable reason.
      const clientVersion = this.tryExec(['--version']);
      if (clientVersion.status !== 0) {
        return {
          runtime: this.name,
          available: false,
          version: null,
          architecture: null,
          serviceRunning: false,
          detail: `${this.binary} CLI not found or not runnable`,
        };
      }
      return {
        runtime: this.name,
        available: true,
        version: null,
        architecture: null,
        serviceRunning: false,
        detail: `${this.binary} CLI present but engine/daemon is not reachable`,
      };
    }
    const arch = this.tryExec(['info', '--format', '{{.Architecture}}']);
    return {
      runtime: this.name,
      available: true,
      version: serverVersion.stdout.trim(),
      architecture: arch.status === 0 ? normalizeOciArchitecture(arch.stdout) : null,
      serviceRunning: true,
      detail: `${this.binary} engine reachable`,
    };
  }
}
