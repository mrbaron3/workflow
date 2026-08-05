#!/usr/bin/env tsx
/**
 * Poll the GitHub PR gate once (ADR-0006 G1): for every needs-human-review issue whose approved
 * build was projected to a PR, read that PR's state and convert a human merge/close into the
 * harness's release/repair decision (recordHumanDecision + humanVerdict harvest). Run it on a
 * cadence (cron / `while sleep`) alongside the drive — it is the L1-style poll for the gate.
 *
 * Requires config.gate.backend === 'github' and `gh` auth. A no-op for the store-direct gate.
 * `gh` runs in the target repo dir (its remote owns the PRs).
 */

import path from 'node:path';
import { Store } from '../src/store/store.js';
import { loadConfig } from '../src/config.js';
import { pollGate, realGhGateRunner } from '../src/pipeline/execution/gate.js';
import { REPOSITORY_ROOT } from '../src/runtime/roots.js';

const ROOT = REPOSITORY_ROOT;
if (!Store.isInitialized(ROOT)) {
  console.error('No store. Run:  npx tsx apps/agentops/scripts/real-run-sandbox.ts');
  process.exit(1);
}

const store = new Store(ROOT);
const config = loadConfig(ROOT);

if ((config.gate?.backend ?? 'store') !== 'github') {
  console.error('gate.backend is not "github" — nothing to poll (store-direct gate awaits recordHumanDecision).');
  process.exit(1);
}
if (!config.target) {
  console.error('config.target is required (gh runs in the target repo dir).');
  process.exit(1);
}

const repoDir = path.resolve(ROOT, config.target.repo);
const results = pollGate(store, config, realGhGateRunner(), repoDir, (m) => console.log(m));

console.log('\n=== gate poll ===');
if (results.length === 0) console.log('no github-projected issues awaiting a decision.');
for (const r of results) {
  console.log(`${r.issueId}: PR ${r.state}${r.decision ? ` → ${r.decision}` : ' (pending)'} → status=${r.status}`);
}
