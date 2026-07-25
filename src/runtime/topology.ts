/**
 * The isolated 3-container topology and its publish invariant (issue #11: 「control だけが 127.0.0.1
 * へ publish され、runner／PostgreSQL は内部 network だけに置ける構成を最小構成で検証」).
 *
 * The invariant is enforced two independent ways, both fail-closed:
 *   1. STATIC — `inspectPublishInvariant` checks a *desired* `TopologySpec` before anything starts:
 *      only the control role may publish, only to 127.0.0.1, and every container sits on the one
 *      internal network. This is the automatic config check the AC calls for.
 *   2. GROUNDED — `verifyHostPublishSurface` probes the Mac loopback of a *running* topology: the
 *      control port must be reachable and every internal-only port must be refused. This is
 *      runtime-independent (it tests the host, not a CLI's inspect JSON), so it is honest evidence.
 */

import net from 'node:net';
import {
  LOOPBACK_HOST_IP,
  OFFICIAL_POSTGRES_IMAGE,
  type PublishInspection,
  type TopologySpec,
} from './schema.js';

// --- static invariant (desired topology) -----------------------------------

/**
 * Checks a desired topology against the publish invariant. Returns a fail-closed inspection:
 * `ok` is false with concrete `violations` if any non-control container publishes, any control
 * publish targets a non-loopback host IP, control publishes nothing, or a container is off the
 * declared internal network.
 */
export function inspectPublishInvariant(topology: TopologySpec): PublishInspection {
  const violations: string[] = [];
  let controlPublishCount = 0;

  for (const container of topology.containers) {
    if (container.network !== topology.network.name) {
      violations.push(
        `container "${container.name}" is on network "${container.network}", not the internal `
        + `network "${topology.network.name}"`,
      );
    }
    if (container.role === 'control') {
      controlPublishCount += container.publish.length;
      for (const publication of container.publish) {
        if (publication.hostIp !== LOOPBACK_HOST_IP) {
          violations.push(
            `control container "${container.name}" publishes to host ${publication.hostIp}:`
            + `${publication.hostPort} — only ${LOOPBACK_HOST_IP} may be published to the Mac`,
          );
        }
      }
    } else {
      for (const publication of container.publish) {
        violations.push(
          `${container.role} container "${container.name}" publishes ${publication.hostIp}:`
          + `${publication.hostPort} — only the control role may publish to the Mac`,
        );
      }
    }
  }

  if (controlPublishCount === 0) {
    violations.push(
      'no control container publishes a loopback port — the control plane would be unreachable',
    );
  }

  return { ok: violations.length === 0, violations };
}

/** Thrown by `assertPublishInvariant` when a desired topology violates the publish red line. */
export class PublishInvariantError extends Error {
  constructor(readonly violations: string[]) {
    super(`publish invariant violated:\n- ${violations.join('\n- ')}`);
    this.name = 'PublishInvariantError';
  }
}

/** Fail-fast form of `inspectPublishInvariant` for call sites that must not proceed on violation. */
export function assertPublishInvariant(topology: TopologySpec): void {
  const inspection = inspectPublishInvariant(topology);
  if (!inspection.ok) throw new PublishInvariantError(inspection.violations);
}

// --- grounded invariant (running host surface) -----------------------------

/** Probes whether a TCP port accepts a connection on the Mac loopback. Injected for testability. */
export type LoopbackProbe = (port: number) => Promise<boolean>;

export interface HostPublishExpectation {
  /** Loopback ports that MUST accept a connection (the control plane's published ports). */
  mustBeReachable: number[];
  /** Loopback ports that MUST be refused (internal-only services — postgres 5432, runner). */
  mustNotBeReachable: number[];
}

/**
 * Derives the host expectation from a desired topology plus the set of internal service ports that
 * must never leak to the Mac. Reachable = every control publish host port; unreachable = the caller's
 * internal ports (which the topology deliberately does not publish).
 */
export function hostExpectationForTopology(
  topology: TopologySpec,
  internalPortsThatMustNotLeak: number[],
): HostPublishExpectation {
  const mustBeReachable = topology.containers
    .filter((container) => container.role === 'control')
    .flatMap((container) => container.publish.map((publication) => publication.hostPort));
  return { mustBeReachable, mustNotBeReachable: internalPortsThatMustNotLeak };
}

/**
 * Grounds the publish invariant against a running topology by probing the Mac loopback. Fail-closed:
 * a control port that is unreachable, or an internal port that IS reachable, is a violation.
 */
export async function verifyHostPublishSurface(
  expectation: HostPublishExpectation,
  probe: LoopbackProbe,
): Promise<PublishInspection> {
  const violations: string[] = [];
  for (const port of expectation.mustBeReachable) {
    if (!(await probe(port))) {
      violations.push(
        `expected control loopback port ${port} to be reachable on ${LOOPBACK_HOST_IP}, but it was not`,
      );
    }
  }
  for (const port of expectation.mustNotBeReachable) {
    if (await probe(port)) {
      violations.push(
        `internal-only port ${port} is reachable on ${LOOPBACK_HOST_IP} — it must not be published to the Mac`,
      );
    }
  }
  return { ok: violations.length === 0, violations };
}

/** A real loopback probe using a short-lived TCP connect. `true` iff the port accepts a connection. */
export function tcpLoopbackProbe(timeoutMs: number = 500): LoopbackProbe {
  return (port) => new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: LOOPBACK_HOST_IP, port });
    let settled = false;
    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

// --- default topology builder ----------------------------------------------

export interface AgentopsTopologyOptions {
  /** Standard OCI application image (the runner / control stand-in). */
  appImage: string;
  /** Loopback host port the control plane publishes. */
  controlHostPort: number;
  /** Container port the control plane listens on. */
  controlContainerPort: number;
  /** Internal PostgreSQL service port (never published). */
  postgresPort?: number;
  networkName?: string;
  namePrefix?: string;
  postgresImage?: string;
  postgresVolume?: string;
  postgresPassword?: string;
  /** Control container command; defaults to a tiny node HTTP listener on the control port. */
  controlCommand?: string[];
  /** Runner container command; defaults to a node keep-alive so the container stays up. */
  runnerCommand?: string[];
}

/** A node one-liner HTTP listener, so the built app image (node-based) can serve as the control stand-in. */
export function nodeHttpListenerCommand(port: number): string[] {
  return [
    'node',
    '-e',
    `require('http').createServer((_,res)=>res.end('ok')).listen(${port},'0.0.0.0')`,
  ];
}

/** A node keep-alive command, so a container without a long-running service stays up for the smoke. */
export function nodeKeepAliveCommand(): string[] {
  return ['node', '-e', 'setInterval(() => {}, 1 << 30)'];
}

/**
 * Builds the canonical isolated topology: control publishes exactly one 127.0.0.1 port; runner and
 * postgres are internal-only; postgres uses the official image on a persistent volume. The result
 * satisfies `inspectPublishInvariant` by construction (asserted in tests).
 */
export function agentopsTopology(options: AgentopsTopologyOptions): TopologySpec {
  const prefix = options.namePrefix ?? 'agentops';
  const networkName = options.networkName ?? `${prefix}-internal`;
  const postgresVolume = options.postgresVolume ?? `${prefix}-postgres-data`;
  const postgresPort = options.postgresPort ?? 5432;

  return {
    network: { name: networkName },
    volumes: [{ name: postgresVolume }],
    containers: [
      {
        role: 'control',
        name: `${prefix}-control`,
        image: options.appImage,
        network: networkName,
        publish: [{
          hostIp: LOOPBACK_HOST_IP,
          hostPort: options.controlHostPort,
          containerPort: options.controlContainerPort,
        }],
        volumes: [],
        env: {},
        command: options.controlCommand ?? nodeHttpListenerCommand(options.controlContainerPort),
      },
      {
        role: 'runner',
        name: `${prefix}-runner`,
        image: options.appImage,
        network: networkName,
        publish: [],
        volumes: [],
        env: {},
        command: options.runnerCommand ?? nodeKeepAliveCommand(),
      },
      {
        role: 'postgres',
        name: `${prefix}-postgres`,
        image: options.postgresImage ?? OFFICIAL_POSTGRES_IMAGE,
        network: networkName,
        publish: [],
        volumes: [{ volume: postgresVolume, mountPath: '/var/lib/postgresql/data', readOnly: false }],
        env: {
          POSTGRES_PASSWORD: options.postgresPassword ?? 'agentops-smoke',
          POSTGRES_DB: 'agentops',
          PGPORT: String(postgresPort),
        },
      },
    ],
  };
}
