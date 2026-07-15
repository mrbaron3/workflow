/**
 * Workspace target binding (DOM/ARCH-workspace): one durable organisation store may mutate
 * state for exactly one target repository. Config is intentionally not the authority — changing
 * config.target cannot rebind an existing store.
 */

import fs from 'node:fs';
import type { HarnessConfig } from '../config.js';
import { resolveTargetRoot } from '../config.js';
import type { DB } from '../domain/schema.js';
import type { Store } from '../store/store.js';
import { nowISO } from '../store/store.js';

export class BindingMismatchError extends Error {
  constructor(readonly boundTarget: string, readonly requestedTarget: string) {
    super(
      `store target mismatch: bound=${boundTarget} requested=${requestedTarget}. ` +
        `Use a separate harness store for the requested target; an existing binding cannot be replaced.`,
    );
    this.name = 'BindingMismatchError';
  }
}

export class LegacyUnboundStoreError extends Error {
  constructor(readonly requestedTarget: string) {
    super(
      `legacy store has organisation state but no target binding; refusing to infer ${requestedTarget}. ` +
        `Run agentops bind-target once with the intended target configuration.`,
    );
    this.name = 'LegacyUnboundStoreError';
  }
}

export interface BindingOptions {
  now?: () => string;
}

/** Resolve syntactic path variants and symlinks to one local repository identity. */
export function resolveTargetIdentity(config: HarnessConfig, harnessRoot: string): string {
  const targetRoot = resolveTargetRoot(config, harnessRoot);
  try {
    return fs.realpathSync(targetRoot);
  } catch {
    throw new Error(`cannot resolve target repository: ${targetRoot}`);
  }
}

/** True when binding the requested target cannot claim pre-existing organisation state. */
export function isEmptyOrganisationStore(db: DB): boolean {
  return (
    db.roadmap === null &&
    db.epics.length === 0 &&
    db.features.length === 0 &&
    db.issues.length === 0 &&
    db.prs.length === 0 &&
    db.evalRuns.length === 0 &&
    db.evalTasks.length === 0 &&
    db.regressionRuns.length === 0 &&
    db.promptRecords.length === 0 &&
    db.agentInvocations.length === 0 &&
    db.intakeRecords.length === 0 &&
    db.planningEnrichments.length === 0 &&
    db.interventions.length === 0 &&
    db.turnRecords.length === 0 &&
    db.specStates.length === 0 &&
    Object.keys(db.counters).length === 0
  );
}

/**
 * Common preflight for every state-changing command. Empty stores bind lazily; non-empty legacy
 * stores require explicit migration, and an existing binding is immutable.
 */
export function prepareStoreMutation(
  store: Store,
  config: HarnessConfig,
  harnessRoot: string,
  opts: BindingOptions = {},
): 'matched' | 'bound-empty' {
  const requested = resolveTargetIdentity(config, harnessRoot);
  const current = store.db.targetBinding;
  if (current) {
    if (current.targetIdentity !== requested) {
      throw new BindingMismatchError(current.targetIdentity, requested);
    }
    return 'matched';
  }
  if (!isEmptyOrganisationStore(store.db)) throw new LegacyUnboundStoreError(requested);
  store.db.targetBinding = { targetIdentity: requested, boundAt: (opts.now ?? nowISO)() };
  return 'bound-empty';
}

/** Explicit, one-time migration for stores that predate DATA-workspace-001. Never rebinds. */
export function bindLegacyStore(
  store: Store,
  config: HarnessConfig,
  harnessRoot: string,
  opts: BindingOptions = {},
): 'bound' | 'already-bound' {
  const requested = resolveTargetIdentity(config, harnessRoot);
  const current = store.db.targetBinding;
  if (current) {
    if (current.targetIdentity !== requested) {
      throw new BindingMismatchError(current.targetIdentity, requested);
    }
    return 'already-bound';
  }
  store.db.targetBinding = { targetIdentity: requested, boundAt: (opts.now ?? nowISO)() };
  return 'bound';
}

const STORE_MUTATIONS = new Set([
  'sign',
  'plan',
  'plan-roadmap',
  'spawn-specs',
  'spawn-issues',
  'contract-draft',
  'assign',
  'poll-intake',
  'github-turn',
  'watch-github',
  'run',
  'curate',
  'regress',
  'adopt',
  'decline',
  'retire',
  'decide',
  'label',
  'intervene',
  'demo',
]);

/** Single CLI policy: read-only commands stay observable even under a mismatch. */
export function commandChangesStore(cmd: string, flags: Record<string, string | boolean>): boolean {
  return STORE_MUTATIONS.has(cmd) || (cmd === 'analyze' && flags.create === true);
}
