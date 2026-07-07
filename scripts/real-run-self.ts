#!/usr/bin/env tsx
/**
 * Point the harness at ITSELF (ADR-0007 I3): configure config.target so the execution
 * layer drives adopted type:harness / type:eval issues as git worktrees of THIS repo,
 * graded by the repo's own tsc + vitest — the existing all-green suite is the regression
 * net — plus the env-gated acceptance suite (test/acceptance-harness/**, collected only
 * under ACCEPT_HARNESS=1: red at baseline until the adopted fix lands).
 *
 * Unlike real-run-sandbox.ts this NEVER wipes the store: the failure history, curated
 * eval tasks and the adopted issue are exactly what this run exists to drive.
 *
 *   npx tsx scripts/real-run-self.ts                          # configure + show the queue
 *   LENSES=codeQuality,testQuality npx tsx scripts/real-panel-run.ts   # then drive it
 */

import path from 'node:path';
import { Store } from '../src/store/store.js';
import { loadConfig, saveConfig, type HarnessConfig } from '../src/config.js';
import { pollable } from '../src/pipeline/execution/guard.js';

const ROOT = process.cwd();
const BIN = path.join(ROOT, 'node_modules', '.bin');

if (!Store.isInitialized(ROOT)) {
  console.error('No store — nothing adopted to drive. (agentops analyze --create → agentops adopt <ID> --contract …)');
  process.exit(1);
}
const store = new Store(ROOT);

// Model overrides mirror real-run-sandbox.ts. IMPORTANT: absent env DROPS any stale
// override left by a sandbox experiment (e.g. a haiku generator) — a self-hosted fix
// should default to the user's default (strong) model.
const genModel = process.env.GEN_MODEL;
const reviewModel = process.env.REVIEW_MODEL;
const models = genModel || reviewModel ? { generator: genModel, reviewer: reviewModel } : undefined;

const config: HarnessConfig = {
  ...loadConfig(ROOT),
  generator: 'claude',
  samples: 1,
  maxRepairs: process.env.MAX_REPAIRS ? Number(process.env.MAX_REPAIRS) : 1,
  target: {
    repo: '.',
    baseRef: 'HEAD',
    graders: {
      typecheck: `${path.join(BIN, 'tsc')} --noEmit -p tsconfig.json`,
      // env-gate (ADR-0007 I3): the grader — and only the grader — collects the
      // harness-owned acceptance suite. grade.ts peels the leading KEY=VAL itself.
      unit_tests: `ACCEPT_HARNESS=1 ${path.join(BIN, 'vitest')} run`,
    },
    protectedPaths: ['test/acceptance-harness/'],
    systemDir: 'docs/specs/_system',
  },
};
if (models) config.models = models;
else delete config.models;
saveConfig(ROOT, config);

const queue = pollable(store, config);
console.log(`✓ config.target → this repo (graders: own tsc/vitest + ACCEPT_HARNESS gate, maxRepairs=${config.maxRepairs})`);
console.log(models ? `  models: generator=${genModel ?? 'default'}, reviewer=${reviewModel ?? 'default'}` : '  models: default (any sandbox override dropped)');
console.log(`\npollable queue (${queue.length}):`);
for (const i of queue) console.log(`  ${i.id} [${i.type}] ${i.title}`);
if (queue.length === 0) {
  console.log('  (empty — adopt an improvement first: agentops analyze --create → agentops adopt <ID> --contract scripts/seeds/scope-exclude.contract.yaml)');
}
console.log(`\nNext:  LENSES=codeQuality,testQuality npx tsx scripts/real-panel-run.ts`);
