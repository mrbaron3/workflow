/**
 * Container-runtime contracts (the context's Published Language).
 *
 * This bounded context owns the *container* runtime substrate — building a standard
 * OCI application image and driving Apple Container (or any OCI-compatible CLI) to run
 * the isolated control / runner / postgres topology of parent #10. It is deliberately
 * distinct from `agent-runtime` (which owns non-deterministic *AI* invocation): the two
 * only share the word "runtime".
 *
 * Every value that crosses the adapter boundary — a preflight report, a container spec,
 * an observed publish surface — is validated against a schema here so the OS-independent
 * core never depends on the shape of a particular CLI's output (AC-CISO-011).
 */

import { z } from 'zod';

// --- small vocabularies ----------------------------------------------------

/** The image / VM architecture. Apple Container is Apple-Silicon only (arm64). */
export const ContainerArchitecture = z.enum(['arm64', 'amd64']);
export type ContainerArchitecture = z.infer<typeof ContainerArchitecture>;

/**
 * The three isolated roles of the CISO topology (parent #10 「採用する構成」). Only
 * `control` is ever published to the Mac; `runner` and `postgres` live on the internal
 * network exclusively. The role is what the publish invariant (topology.ts) keys on, so
 * it is a first-class value, not a free string.
 */
export const RuntimeRole = z.enum(['control', 'runner', 'postgres']);
export type RuntimeRole = z.infer<typeof RuntimeRole>;

/**
 * The only host IP a container may publish to. Publishing to `0.0.0.0` (all interfaces)
 * or a LAN address is a red line (parent #10 セキュリティレッドライン): it would expose
 * the control plane beyond the Mac loopback.
 */
export const LOOPBACK_HOST_IP = '127.0.0.1';

/** The official upstream PostgreSQL image is used verbatim — the postgres role builds no custom image. */
export const OFFICIAL_POSTGRES_IMAGE = 'postgres:16';

// --- structural contracts --------------------------------------------------

/** A published host↔container port binding. `hostIp` is compared against LOOPBACK_HOST_IP. */
export const PortPublication = z.object({
  hostIp: z.string().min(1),
  hostPort: z.number().int().positive(),
  containerPort: z.number().int().positive(),
});
export type PortPublication = z.infer<typeof PortPublication>;

/**
 * A named persistent volume mounted at a container-absolute path. `mountPath` is a path
 * *inside* the container (e.g. /var/lib/postgresql/data) and must never be a Mac host path
 * — the whole point of the epic is that the container carries no `/Users/...` dependency.
 */
export const VolumeMount = z.object({
  volume: z.string().min(1),
  mountPath: z.string().min(1),
  readOnly: z.boolean().default(false),
});
export type VolumeMount = z.infer<typeof VolumeMount>;

/** A private internal network. Containers on it reach each other; the Mac does not route to it. */
export const NetworkSpec = z.object({
  name: z.string().min(1),
});
export type NetworkSpec = z.infer<typeof NetworkSpec>;

/** A named persistent volume declaration. */
export const VolumeSpec = z.object({
  name: z.string().min(1),
});
export type VolumeSpec = z.infer<typeof VolumeSpec>;

/**
 * Everything needed to run one container, in runtime-neutral terms. The adapter translates
 * this into a specific CLI's argv; the core never authors argv itself.
 */
export const ContainerSpec = z.object({
  role: RuntimeRole,
  name: z.string().min(1),
  image: z.string().min(1),
  network: z.string().min(1),
  publish: z.array(PortPublication).default([]),
  volumes: z.array(VolumeMount).default([]),
  env: z.record(z.string()).default({}),
  /** Container-absolute working directory. Absent = the image default. */
  workdir: z.string().optional(),
  /** Override the image entrypoint/command. Absent = the image default. */
  command: z.array(z.string()).optional(),
});
export type ContainerSpec = z.infer<typeof ContainerSpec>;

/**
 * A whole topology: one internal network, its persistent volumes, and the containers on it.
 * The publish invariant (topology.ts) is asserted against this shape before anything starts.
 */
export const TopologySpec = z.object({
  network: NetworkSpec,
  volumes: z.array(VolumeSpec).default([]),
  containers: z.array(ContainerSpec).min(1),
});
export type TopologySpec = z.infer<typeof TopologySpec>;

// --- capability & preflight -------------------------------------------------

/**
 * What the adapter could learn about the runtime without mutating anything. `available`
 * is false when the CLI is absent; the remaining fields are best-effort and nullable so a
 * partially-probed runtime is never reported as fully capable.
 */
export const CapabilityReport = z.object({
  runtime: z.string().min(1),
  available: z.boolean(),
  version: z.string().nullable(),
  architecture: ContainerArchitecture.nullable(),
  serviceRunning: z.boolean(),
  detail: z.string(),
});
export type CapabilityReport = z.infer<typeof CapabilityReport>;

/** The distinct things preflight verifies. Ordered cheapest-first in preflight.ts. */
export const PreflightCheckId = z.enum([
  'cli_present',
  'cli_version',
  'architecture',
  'service_running',
  'network_lifecycle',
  'volume_lifecycle',
  'oci_image_run',
]);
export type PreflightCheckId = z.infer<typeof PreflightCheckId>;

export const PreflightCheck = z.object({
  id: PreflightCheckId,
  /** A failed required check makes the whole report fail-closed; optional checks only warn. */
  required: z.boolean(),
  ok: z.boolean(),
  detail: z.string(),
});
export type PreflightCheck = z.infer<typeof PreflightCheck>;

/**
 * The fail-closed preflight verdict. `ok` is true ONLY when every required check passed.
 * A short-circuited probe (CLI missing) still returns a report — with `ok: false` and the
 * reason — rather than throwing, so callers get a structured refusal, never a fabricated pass.
 */
export const PreflightReport = z.object({
  runtime: z.string().min(1),
  ok: z.boolean(),
  checks: z.array(PreflightCheck),
});
export type PreflightReport = z.infer<typeof PreflightReport>;

// --- publish-surface inspection --------------------------------------------

/**
 * The result of checking a desired topology, or an observed host surface, against the publish
 * invariant. `ok` false carries human-readable `violations`; callers fail-closed on any violation.
 */
export const PublishInspection = z.object({
  ok: z.boolean(),
  violations: z.array(z.string()),
});
export type PublishInspection = z.infer<typeof PublishInspection>;

// --- container-neutral paths -----------------------------------------------

/**
 * The in-container paths the harness resolves at runtime. Every one is container-absolute
 * and configurable via env; none may be a Mac host path (paths.ts enforces this). This is
 * the concrete form of "grader / workspace / systemDir をコンテナ内の相対／設定可能 path で解決".
 */
export const ContainerNeutralPaths = z.object({
  appRoot: z.string().min(1),
  workspaceRoot: z.string().min(1),
  storeRoot: z.string().min(1),
  systemDir: z.string().min(1),
});
export type ContainerNeutralPaths = z.infer<typeof ContainerNeutralPaths>;
