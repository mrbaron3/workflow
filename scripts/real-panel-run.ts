#!/usr/bin/env tsx
/**
 * Drive one grounded FULL-PANEL run against the scaffolded sandbox (scripts/real-run-sandbox.ts):
 * a real generator session, then real read-only perspective sessions, graded by runPanel, routed
 * through the review gate. Watch it live: `tmux attach -t ao-…` / `ao-eval-…`.
 *
 * Cost control: set LENSES to a comma-separated subset to convene fewer live review sessions,
 * e.g.  LENSES=codeQuality,security npx tsx scripts/real-panel-run.ts
 * Default convenes all six review lenses (+ deterministic functionality).
 */

import { Store } from '../src/store/store.js';
import { loadConfig } from '../src/config.js';
import { runLoopLive } from '../src/pipeline/execution/live.js';
import { PERSPECTIVES } from '../src/pipeline/panel.js';

const ROOT = process.cwd();
if (!Store.isInitialized(ROOT)) {
  console.error('No store. Run:  npx tsx scripts/real-run-sandbox.ts');
  process.exit(1);
}

const only = (process.env.LENSES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
// always keep functionality (deterministic, free); filter the review lenses to `only` when set
const perspectives = only.length
  ? PERSPECTIVES.filter((p) => p.deterministic || only.includes(p.key))
  : PERSPECTIVES;

const store = new Store(ROOT);
const config = loadConfig(ROOT);
console.log(`lenses: ${perspectives.map((p) => p.key + (p.deterministic ? '(det)' : '')).join(', ')}\n`);

const results = await runLoopLive(store, config, ROOT, { perspectives }, (m) => console.log(m));

console.log('\n=== results ===');
for (const r of results) {
  console.log(`${r.issueId}: panel=${r.verdict}${r.gateFailed ? ' [gate-failed]' : ''}${r.escalated ? ' [escalated]' : ''} → status=${r.status}`);
}
console.log('\nApprove/reject at the gate with recordHumanDecision (needs-human-review issues await you).');
