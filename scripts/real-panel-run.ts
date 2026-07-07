#!/usr/bin/env tsx
/**
 * Drive one grounded FULL-PANEL run against the scaffolded sandbox (scripts/real-run-sandbox.ts):
 * a real generator session, then real read-only perspective sessions, graded by runPanel, routed
 * through the review gate. Watch it live: `tmux attach -t ao-…` / `ao-eval-…`.
 *
 * Cost control: set LENSES to a comma-separated subset to convene fewer live review sessions,
 * e.g.  LENSES=codeQuality,security npx tsx scripts/real-panel-run.ts
 * Default convenes all six review lenses (+ deterministic functionality).
 *
 * Best-of-N (ADR-0006 E5): SAMPLES=k drives k independent samples per issue; default is
 * first-approve-stop. Add MEASURE=1 to run ALL k to completion for pass@k / pass^k, e.g.
 *   SAMPLES=3 MEASURE=1 npx tsx scripts/real-panel-run.ts   (then: npx tsx scripts/report.ts or computeMetrics)
 */

import { Store } from '../src/store/store.js';
import { loadConfig } from '../src/config.js';
import { runLoopLive } from '../src/pipeline/execution/live.js';
import { PERSPECTIVES } from '../src/pipeline/panel.js';
import { WINDOW_HOLDER } from '../src/pipeline/execution/tmux.js';

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
const samples = process.env.SAMPLES ? Math.max(1, Number(process.env.SAMPLES)) : undefined;
const measure = process.env.MEASURE === '1';
console.log(`lenses: ${perspectives.map((p) => p.key + (p.deterministic ? '(det)' : '')).join(', ')}`);
console.log(`samples: ${samples ?? config.samples}${measure ? ' [measure: run all for pass@k/pass^k]' : ' [first-approve-stop]'}`);
// Every generator/reviewer session opens as a tab of this one holder — attach to watch them live.
console.log(`▶ watch live:  tmux attach -t ${WINDOW_HOLDER}   (each session is a tab; finished tabs close)\n`);

const results = await runLoopLive(store, config, ROOT, { perspectives, samples, measure }, (m) => console.log(m));

console.log('\n=== results ===');
for (const r of results) {
  const n = r.sampleCount && r.sampleCount > 1 ? ` [${r.sampleCount} samples]` : '';
  console.log(`${r.issueId}: panel=${r.verdict}${n}${r.gateFailed ? ' [gate-failed]' : ''}${r.escalated ? ' [escalated]' : ''} → status=${r.status}`);
}
console.log('\nApprove/reject at the gate with recordHumanDecision (needs-human-review issues await you).');
