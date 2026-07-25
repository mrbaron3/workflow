import { describe, it, expect } from 'vitest';
import {
  PublishInvariantError,
  agentopsTopology,
  assertPublishInvariant,
  hostExpectationForTopology,
  inspectPublishInvariant,
  verifyHostPublishSurface,
  type LoopbackProbe,
} from '../src/runtime/topology.js';
import type { TopologySpec } from '../src/runtime/schema.js';

function baseTopology(): TopologySpec {
  return agentopsTopology({
    appImage: 'agentops-app:smoke',
    controlHostPort: 17600,
    controlContainerPort: 8080,
    postgresPassword: 'pw',
    namePrefix: 'agentops-smoke',
  });
}

/** A probe that reports the given ports reachable and everything else refused. */
function probeReachable(reachable: number[]): LoopbackProbe {
  return (port) => Promise.resolve(reachable.includes(port));
}

describe('publish invariant — static (desired topology)', () => {
  it('AC-CISO-011 accepts the default topology: control publishes only 127.0.0.1, others internal', () => {
    expect(inspectPublishInvariant(baseTopology())).toEqual({ ok: true, violations: [] });
  });

  it('rejects a runner or postgres that publishes to the Mac', () => {
    const topology = baseTopology();
    topology.containers[1]!.publish = [{ hostIp: '127.0.0.1', hostPort: 5432, containerPort: 5432 }];
    const inspection = inspectPublishInvariant(topology);
    expect(inspection.ok).toBe(false);
    expect(inspection.violations[0]).toContain('only the control role may publish');
  });

  it('rejects a control port bound to a non-loopback host IP', () => {
    const topology = baseTopology();
    topology.containers[0]!.publish = [{ hostIp: '0.0.0.0', hostPort: 17600, containerPort: 8080 }];
    const inspection = inspectPublishInvariant(topology);
    expect(inspection.ok).toBe(false);
    expect(inspection.violations[0]).toContain('only 127.0.0.1');
  });

  it('rejects a topology where control publishes nothing (control plane unreachable)', () => {
    const topology = baseTopology();
    topology.containers[0]!.publish = [];
    expect(inspectPublishInvariant(topology).violations).toContain(
      'no control container publishes a loopback port — the control plane would be unreachable',
    );
  });

  it('rejects a container that is off the internal network', () => {
    const topology = baseTopology();
    topology.containers[2]!.network = 'some-other-network';
    const inspection = inspectPublishInvariant(topology);
    expect(inspection.ok).toBe(false);
    expect(inspection.violations.some((v) => v.includes('not the internal network'))).toBe(true);
  });

  it('AC-CISO-011 rejects a host bind mount source (no /Users mount past the invariant)', () => {
    const topology = baseTopology();
    topology.containers[2]!.volumes = [{ volume: '/Users/alice/Company', mountPath: '/workspace', readOnly: false }];
    const inspection = inspectPublishInvariant(topology);
    expect(inspection.ok).toBe(false);
    expect(inspection.violations.some((v) => v.includes('host bind mount is not allowed'))).toBe(true);
  });

  it('rejects a volume source not declared in the topology volumes', () => {
    const topology = baseTopology();
    topology.containers[2]!.volumes = [{ volume: 'undeclared-vol', mountPath: '/var/lib/postgresql/data', readOnly: false }];
    const inspection = inspectPublishInvariant(topology);
    expect(inspection.ok).toBe(false);
    expect(inspection.violations.some((v) => v.includes('not declared in'))).toBe(true);
  });

  it('assertPublishInvariant throws PublishInvariantError on violation', () => {
    const topology = baseTopology();
    topology.containers[1]!.publish = [{ hostIp: '127.0.0.1', hostPort: 9, containerPort: 9 }];
    expect(() => assertPublishInvariant(topology)).toThrow(PublishInvariantError);
    expect(() => assertPublishInvariant(baseTopology())).not.toThrow();
  });
});

describe('publish invariant — grounded (running host surface)', () => {
  it('derives reachable=control-publish, unreachable=internal, refused-off-loopback=control', () => {
    const expectation = hostExpectationForTopology(baseTopology(), [5432, 8080]);
    expect(expectation).toEqual({
      mustBeReachable: [17600],
      mustNotBeReachable: [5432, 8080],
      mustBeRefusedOffLoopback: [17600],
    });
  });

  it('AC-CISO-011 passes when control is reachable and internal ports are refused on the Mac', async () => {
    const expectation = hostExpectationForTopology(baseTopology(), [5432, 8080]);
    const inspection = await verifyHostPublishSurface(expectation, probeReachable([17600]));
    expect(inspection).toEqual({ ok: true, violations: [] });
  });

  it('AC-CISO-011 fails when the control port is reachable OFF the loopback interface (0.0.0.0/LAN)', async () => {
    const expectation = hostExpectationForTopology(baseTopology(), [5432]);
    // control (17600) reachable on loopback AND off-loopback → published to 0.0.0.0, a violation.
    const inspection = await verifyHostPublishSurface(
      expectation, probeReachable([17600]), probeReachable([17600]),
    );
    expect(inspection.ok).toBe(false);
    expect(inspection.violations[0]).toContain('off the loopback interface');
  });

  it('passes off-loopback when the control port is refused on the non-loopback interface', async () => {
    const expectation = hostExpectationForTopology(baseTopology(), [5432]);
    const inspection = await verifyHostPublishSurface(
      expectation, probeReachable([17600]), probeReachable([]),
    );
    expect(inspection).toEqual({ ok: true, violations: [] });
  });

  it('fails when the control port is not reachable', async () => {
    const inspection = await verifyHostPublishSurface(
      { mustBeReachable: [17600], mustNotBeReachable: [5432] },
      probeReachable([]),
    );
    expect(inspection.ok).toBe(false);
    expect(inspection.violations[0]).toContain('to be reachable');
  });

  it('fails closed when an internal-only port leaks to the Mac loopback', async () => {
    const inspection = await verifyHostPublishSurface(
      { mustBeReachable: [17600], mustNotBeReachable: [5432] },
      probeReachable([17600, 5432]),
    );
    expect(inspection.ok).toBe(false);
    expect(inspection.violations[0]).toContain('must not be published to the Mac');
  });
});

describe('default topology builder', () => {
  it('places postgres on a persistent volume and the official image, internal-only', () => {
    const topology = baseTopology();
    const postgres = topology.containers.find((c) => c.role === 'postgres');
    expect(postgres?.image).toBe('postgres:16');
    expect(postgres?.publish).toEqual([]);
    expect(postgres?.volumes[0]?.mountPath).toBe('/var/lib/postgresql/data');
    expect(topology.volumes.map((v) => v.name)).toContain('agentops-smoke-postgres-data');
  });

  it('gives every container the one internal network', () => {
    const topology = baseTopology();
    for (const container of topology.containers) {
      expect(container.network).toBe(topology.network.name);
    }
  });
});
