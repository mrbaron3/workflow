#!/usr/bin/env tsx
/**
 * Drive one grounded execution run against the scaffolded sandbox (scripts/real-run-sandbox.ts).
 * Polls the ai-managed queue, runs a real Claude session per issue in a tmux worktree, grades
 * the checkout with real tsc/vitest, and records EvalRuns. Watch it live: `tmux attach -t ao-…`.
 */

import { Store } from '../src/store/store.js';
import { loadConfig } from '../src/config.js';
import { runExecutionOnce } from '../src/pipeline/execution/run.js';

const ROOT = process.cwd();
if (!Store.isInitialized(ROOT)) {
  console.error('No store. Run:  npx tsx scripts/real-run-sandbox.ts');
  process.exit(1);
}

const store = new Store(ROOT);
const config = loadConfig(ROOT);
const results = await runExecutionOnce(store, config, ROOT, (m) => console.log(m));

console.log('\n=== results ===');
for (const r of results) {
  const detail = r.outcome === 'completed' ? `overall ${r.overall.toFixed(2)}, ${r.evalId}` : `${r.outcome} — see needs-human-review`;
  console.log(`${r.issueId}: ${r.verdict} (${detail})`);
}
