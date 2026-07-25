/**
 * container-runtime bounded context — the OS-independent container substrate for the CISO topology.
 *
 * Public surface: the runtime-neutral contracts (schema), the adapter port + concrete adapters, the
 * fail-closed preflight, the publish invariant + topology builder, and container-neutral path handling.
 * Import from here rather than reaching into individual modules. Distinct from `agent-runtime`, which
 * owns non-deterministic AI invocation.
 */

export * from './schema.js';
export * from './adapter.js';
export * from './apple-container.js';
export * from './oci-cli.js';
export * from './preflight.js';
export * from './topology.js';
export * from './paths.js';
