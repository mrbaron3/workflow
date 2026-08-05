#!/usr/bin/env tsx
/**
 * Point the harness at ITSELF (ADR-0007 I3): configure config.target so the execution
 * layer drives adopted type:harness / type:eval issues as git worktrees of THIS repo,
 * graded by the repo's own tsc + vitest — the existing all-green suite is the regression
 * net — plus the driven issue's OWN pre-placed acceptance guards
 * (apps/agentops/test/acceptance-harness/**,
 * red at baseline until the adopted fix lands). Activation is issue-scoped (ISSUE-0022):
 * grading injects scopedAcceptEnv(<driven issue>) into the grader child env, so other
 * in-flight issues' guards stay dormant; `ACCEPT_HARNESS=1 vitest run` remains the manual
 * full-activation spelling (baseline-RED checks, whole-registry runs).
 *
 * Unlike real-run-sandbox.ts this NEVER wipes the store: the failure history, curated
 * eval tasks and the adopted issue are exactly what this run exists to drive.
 *
 *   npx tsx apps/agentops/scripts/real-run-self.ts                    # configure + show the queue
 *   LENSES=codeQuality,testQuality npx tsx apps/agentops/scripts/real-panel-run.ts
 */

import path from 'node:path';
import { Store } from '../src/store/store.js';
import { loadConfig, saveConfig, type HarnessConfig } from '../src/config.js';
import { pollable } from '../src/pipeline/execution/guard.js';
import { REPOSITORY_ROOT } from '../src/runtime/roots.js';

const ROOT = REPOSITORY_ROOT;
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
      typecheck: `${path.join(BIN, 'tsc')} --noEmit -p apps/agentops/tsconfig.json`,
      // No ACCEPT_HARNESS=1 prefix here (ISSUE-0022): the grader injects the DRIVEN
      // issue's scoped activation itself (grade.ts × accept.ts), so each build is gated
      // on its own guard delta — a suite-wide prefix would re-open the omnibus gate
      // (the first driven issue gated on other issues' baseline-red payloads).
      unit_tests: `${path.join(BIN, 'vitest')} run --config apps/agentops/vitest.config.ts --configLoader runner`,
    },
    protectedPaths: ['apps/agentops/test/acceptance-harness/'],
    systemDir: 'docs/_system',
  },
};
if (models) config.models = models;
else delete config.models;
saveConfig(ROOT, config);

const queue = pollable(store, config);
console.log(`✓ config.target → this repo (graders: own tsc/vitest, issue-scoped acceptance activation, maxRepairs=${config.maxRepairs})`);
console.log(models ? `  models: generator=${genModel ?? 'default'}, reviewer=${reviewModel ?? 'default'}` : '  models: default (any sandbox override dropped)');
console.log(`\npollable queue (${queue.length}):`);
for (const i of queue) console.log(`  ${i.id} [${i.type}] ${i.title}`);
if (queue.length === 0) {
  console.log('  (empty — adopt an improvement first: agentops analyze --create → agentops adopt <ID> --contract apps/agentops/scripts/seeds/scope-exclude.contract.yaml)');
}
console.log(`\nNext:  LENSES=codeQuality,testQuality npx tsx apps/agentops/scripts/real-panel-run.ts`);
