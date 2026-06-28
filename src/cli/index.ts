/**
 * agentops CLI — the operator's entry point.
 *
 *   init      scaffold .harness/ (the local Eval Result DB) + config
 *   plan      ingest a seed roadmap into Epics + validated Issue Contracts
 *   run       drive issues through Generate -> Evaluate -> Repair -> Release
 *   status    print pass@k / pass^k / cost summary
 *   dashboard write a self-contained HTML dashboard
 *   curate    promote blocker criteria into the Eval Task Registry (regressions)
 *   analyze   propose harness/eval improvement issues from the metrics
 *   label     attach a human verdict to an eval run (for false-pass/fail)
 *   demo      end-to-end: init + plan + run + curate + analyze + dashboard
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Verdict, emptyDB } from '../domain/schema.js';
import { Store, nowISO } from '../store/store.js';
import { parseSpecScenarios, parseAcceptance } from '../authoring/source.js';
import { buildApprovedSpecRef } from '../authoring/sign.js';
import { lintAuthoring } from '../authoring/lint.js';
import { deriveStatus } from '../authoring/drift.js';
import { recheckSpec } from '../authoring/recheck.js';
import {
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  type HarnessConfig,
} from '../config.js';
import { pkgPath } from '../agents/prompts.js';
import { loadSeedFile, planFromSeed } from '../planning/planner.js';
import { runAll, runIssue } from '../pipeline/coordinator.js';
import { makeRunner } from '../agents/runner.js';
import { curateEvalTasks } from '../pipeline/curator.js';
import { analyzeHarness, createSuggestionIssues } from '../pipeline/analyst.js';
import { computeMetrics, statusReport, writeDashboard } from '../dashboard/dashboard.js';

const useColor = !process.env.NO_COLOR;
const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  b: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  blue: (s: string) => (useColor ? `\x1b[34m${s}\x1b[0m` : s),
};
const log = (s = '') => console.log(s);

interface Args {
  cmd: string;
  flags: Record<string, string | boolean>;
  pos: string[];
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const cmd = args[0] ?? 'help';
  const flags: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else pos.push(a);
  }
  return { cmd, flags, pos };
}

const ROOT = process.cwd();

function requireInit(): Store {
  if (!Store.isInitialized(ROOT)) {
    log(c.red('Not initialized.') + ` Run ${c.b('agentops init')} first (or ${c.b('agentops demo')}).`);
    process.exit(1);
  }
  return new Store(ROOT);
}

function applyOverrides(cfg: HarnessConfig, flags: Args['flags']): HarnessConfig {
  const out = { ...cfg };
  if (typeof flags.agent === 'string') out.generator = flags.agent as HarnessConfig['generator'];
  if (typeof flags.samples === 'string') out.samples = Number(flags.samples);
  if (typeof flags['max-repairs'] === 'string') out.maxRepairs = Number(flags['max-repairs']);
  return out;
}

function openFile(file: string): void {
  const cmd =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', file] : [file];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

/** Run git in the repo root and return stdout (throws loudly on non-zero exit). */
function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

/** Repo-root-relative, forward-slash path — git's pathspec form. */
function gitRel(abs: string): string {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

/** Blob SHA of a file's current on-disk content (working tree) — the coarse drift signal. */
function gitHashObject(abs: string): string {
  return git(['hash-object', abs]).trim();
}

// --- commands ---------------------------------------------------------------

function cmdInit(flags: Args['flags']): void {
  if (Store.isInitialized(ROOT) && !flags.force) {
    log(c.yellow('Already initialized.') + ` Use ${c.b('--force')} to reset config (keeps db).`);
    return;
  }
  const store = new Store(ROOT);
  store.save(); // writes .harness/db.json
  saveConfig(ROOT, DEFAULT_CONFIG);
  log(c.green('✓ initialized') + ` ${c.dim(store.dir)}`);
  log(`  db:     ${c.dim(store.dbPath)}`);
  log(`  config: ${c.dim(path.join(store.dir, 'config.json'))} (generator=${DEFAULT_CONFIG.generator})`);
  log(`\nNext: ${c.b('agentops plan')} then ${c.b('agentops run')}.`);
}

function cmdSign(pos: string[]): void {
  const store = requireInit();
  const dir = pos[0];
  if (!dir) {
    log(c.red('usage: agentops sign <spec-dir>') + c.dim('   (dir with spec.md + acceptance.yaml)'));
    process.exit(1);
  }
  const specAbs = path.resolve(ROOT, dir, 'spec.md');
  const accAbs = path.resolve(ROOT, dir, 'acceptance.yaml');
  if (!fs.existsSync(specAbs) || !fs.existsSync(accAbs)) {
    log(c.red(`✗ ${dir} must contain both spec.md and acceptance.yaml`));
    process.exit(1);
  }
  const scenarios = parseSpecScenarios(fs.readFileSync(specAbs, 'utf8'));
  const verifications = parseAcceptance(fs.readFileSync(accAbs, 'utf8'));

  // 1. AUTH-B gate must pass before a signature can be taken (AUTH-C precondition).
  const lint = lintAuthoring({
    specAcIds: scenarios.map((s) => s.id),
    acceptanceAcIds: Object.keys(verifications),
    methodsById: Object.fromEntries(Object.entries(verifications).map(([id, v]) => [id, v.method])),
  });
  if (!lint.ok) {
    log(c.red('✗ cannot sign — authoring lint failed:'));
    for (const e of lint.errors) log(`  - ${e}`);
    process.exit(1);
  }

  // 2. Signature pins committed HEAD blobs (AC-AUTH-007): the files must be clean.
  const dirty = git(['status', '--porcelain', '--', gitRel(specAbs), gitRel(accAbs)]).trim();
  if (dirty) {
    log(c.red('✗ commit spec.md / acceptance.yaml before signing (the signature pins committed blobs):'));
    log(c.dim(dirty));
    process.exit(1);
  }
  const facts = {
    signedCommitSha: git(['rev-parse', 'HEAD']).trim(),
    specBlobGitSha: git(['rev-parse', `HEAD:${gitRel(specAbs)}`]).trim(),
    acceptanceBlobGitSha: git(['rev-parse', `HEAD:${gitRel(accAbs)}`]).trim(),
  };

  // 3. Build + persist the ApprovedSpecRef. status derives, it is never written.
  const approved = buildApprovedSpecRef({ scenarios, verifications, git: facts });
  const now = nowISO();
  const existing = store.getSpecState(dir);
  store.upsertSpecState({
    path: dir,
    featureId: existing?.featureId ?? null, // preserve the planning-tree link across signing (AC-PLAN-008)
    approved,
    signedAt: now,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  store.save();

  const status = deriveStatus(approved.approvedAcIds, scenarios.map((s) => s.id));
  log(c.green('✓ signed') + ` ${c.b(dir)} @ ${c.dim(facts.signedCommitSha.slice(0, 8))}`);
  log(`  ${approved.approvedAcIds.length} AC approved · status=${c.b(status)}`);
}

function cmdSpecs(pos: string[]): void {
  const store = requireInit();
  const states = pos[0] ? store.db.specStates.filter((s) => s.path === pos[0]) : store.db.specStates;
  if (states.length === 0) {
    log(c.dim(pos[0] ? `no signed spec at ${pos[0]}` : 'no signed specs yet — sign one with `agentops sign <spec-dir>`'));
    return;
  }
  for (const st of states) {
    if (!st.approved) {
      log(`${c.b(st.path)}  ${c.yellow('co-authoring')} ${c.dim('(never signed)')}`);
      continue;
    }
    const specAbs = path.resolve(ROOT, st.path, 'spec.md');
    const accAbs = path.resolve(ROOT, st.path, 'acceptance.yaml');
    if (!fs.existsSync(specAbs) || !fs.existsSync(accAbs)) {
      log(`${c.b(st.path)}  ${c.red('broken')} ${c.dim('(spec.md / acceptance.yaml missing)')}`);
      continue;
    }
    const r = recheckSpec({
      approved: st.approved,
      specText: fs.readFileSync(specAbs, 'utf8'),
      acceptanceText: fs.readFileSync(accAbs, 'utf8'),
      currentSpecBlobSha: gitHashObject(specAbs),
      currentAcceptanceBlobSha: gitHashObject(accAbs),
    });
    const color = r.status === 'approved' ? c.green : c.yellow;
    log(`${c.b(st.path)}  ${color(r.status)}  ${c.dim(`signed@${st.approved.signedCommitSha.slice(0, 8)}`)}`);
    if (!r.coarseChanged) {
      log(c.dim('  no change since signing'));
      continue;
    }
    if (r.changed.length) log(`  ${c.yellow('changed')} ${r.changed.join(', ')} ${c.dim('→ re-sign required')}`);
    if (r.added.length) log(`  ${c.yellow('added')}   ${r.added.join(', ')} ${c.dim('→ not yet signed')}`);
    if (r.removed.length) log(`  ${c.blue('removed')} ${r.removed.join(', ')} ${c.dim('→ check design slices for orphans')}`);
    if (!r.changed.length && !r.added.length && !r.removed.length) {
      // Coarse blob moved but no AC meaning changed (prose outside the AC scenarios):
      // the signature still holds — stage ② is what keeps cosmetic edits from failing it.
      log(c.dim('  blob changed but no AC drift (prose-only) — re-sign to re-pin the blob'));
    }
    if (r.status === 'co-authoring') log(c.dim(`  → re-sign with \`agentops sign ${st.path}\` after committing`));
  }
}

function cmdPlan(flags: Args['flags']): void {
  const store = requireInit();
  const seedFile =
    typeof flags.seed === 'string' ? path.resolve(ROOT, flags.seed) : pkgPath('seed', 'sample-roadmap.yaml');
  if (!fs.existsSync(seedFile)) {
    log(c.red(`Seed not found: ${seedFile}`));
    process.exit(1);
  }
  const seed = loadSeedFile(seedFile);
  const res = planFromSeed(store, seed);
  store.save();
  log(c.green('✓ planned') + ` from ${c.dim(path.relative(ROOT, seedFile))}`);
  log(`  ${res.epics} epics, ${res.issues} issues drafted into Issue Contracts.`);
  log(`\nNext: ${c.b('agentops run')}.`);
}

async function cmdRun(flags: Args['flags']): Promise<void> {
  const store = requireInit();
  const cfg = applyOverrides(loadConfig(ROOT), flags);
  log(c.dim(`generator=${cfg.generator} samples=${cfg.samples} maxRepairs=${cfg.maxRepairs}\n`));

  if (typeof flags.issue === 'string') {
    const issue = store.getIssue(flags.issue);
    if (!issue) return void log(c.red(`No such issue: ${flags.issue}`));
    if (issue.status !== 'contract-drafted')
      return void log(c.yellow(`${issue.id} is '${issue.status}', not 'contract-drafted'. Skipping.`));
    const runner = makeRunner(cfg);
    log(c.b(`▶ ${issue.id} ${issue.title}`));
    const r = await runIssue(store, cfg, runner, issue, log);
    store.save();
    log(`\n${r.approved ? c.green('released') : c.red('escalated')} ${issue.id}`);
    return;
  }

  const results = await runAll(store, cfg, log);
  store.save();
  if (results.length === 0) {
    log(c.yellow('Nothing to run.') + ' No issues in status contract-drafted. Run `agentops plan` first.');
    return;
  }
  const released = results.filter((r) => r.approved).length;
  log(`\n${c.green(`${released} released`)}, ${c.red(`${results.length - released} escalated`)} of ${results.length}.`);
  log(`\n${statusReport(store, computeMetrics(store))}`);
}

function cmdStatus(): void {
  const store = requireInit();
  log(statusReport(store, computeMetrics(store)));
}

function cmdDashboard(flags: Args['flags']): void {
  const store = requireInit();
  const { path: out } = writeDashboard(store);
  log(c.green('✓ dashboard') + ` ${out}`);
  if (flags.open) {
    openFile(out);
    log(c.dim('  opening in browser…'));
  } else {
    log(c.dim('  open it, or re-run with --open'));
  }
}

function cmdCurate(): void {
  const store = requireInit();
  const { created } = curateEvalTasks(store);
  store.save();
  log(c.green(`✓ curated ${created.length} eval task(s)`) + ` (registry now ${store.db.evalTasks.length})`);
  for (const t of created.slice(0, 12)) log(`  ${c.dim(t.id)} ${t.userGoal}`);
  if (created.length > 12) log(c.dim(`  …and ${created.length - 12} more`));
}

function cmdAnalyze(flags: Args['flags']): void {
  const store = requireInit();
  const suggestions = analyzeHarness(store, computeMetrics(store));
  if (suggestions.length === 0) return void log(c.green('No harness issues detected. Metrics look healthy.'));
  log(c.b(`Harness Analyst — ${suggestions.length} suggestion(s):\n`));
  for (const s of suggestions) {
    log(`${c.yellow('●')} [${s.type}] ${c.b(s.title)}`);
    log(`  ${c.dim(s.rationale)}\n`);
  }
  if (flags.create) {
    const created = createSuggestionIssues(store, suggestions);
    store.save();
    log(c.green(`✓ created ${created.length} backlog issue(s)`) + ` ${c.dim(created.map((i) => i.id).join(', '))}`);
  } else {
    log(c.dim('Re-run with --create to add these as type:harness / type:eval issues.'));
  }
}

function cmdLabel(flags: Args['flags']): void {
  const store = requireInit();
  const runId = flags.run;
  const human = flags.human;
  if (typeof runId !== 'string' || typeof human !== 'string') {
    log(c.red('Usage: agentops label --run EVAL-00001 --human approve|request_changes|needs_human'));
    process.exit(1);
  }
  const parsed = Verdict.safeParse(human);
  if (!parsed.success) {
    log(c.red(`Invalid verdict '${human}'. Use approve | request_changes | needs_human.`));
    process.exit(1);
  }
  const run = store.db.evalRuns.find((r) => r.id === runId);
  if (!run) return void log(c.red(`No such eval run: ${runId}`));
  run.humanVerdict = parsed.data;
  store.save();
  const agree = run.verdict === parsed.data;
  log(c.green('✓ labelled') + ` ${runId}: grader=${run.verdict} human=${parsed.data} ${agree ? c.green('(agree)') : c.red('(disagree)')}`);
}

async function cmdDemo(flags: Args['flags']): Promise<void> {
  log(c.b('AgentOps demo — running the whole loop on the sample roadmap.\n'));
  // 1. init (fresh — wipe any previous demo state so numbers don't stack)
  const store = new Store(ROOT);
  fs.rmSync(store.evidenceRoot, { recursive: true, force: true });
  store.db = emptyDB();
  store.save();
  saveConfig(ROOT, DEFAULT_CONFIG);
  log(c.green('① init') + c.dim(` ${store.dir}`));

  // 2. plan
  const seed = loadSeedFile(pkgPath('seed', 'sample-roadmap.yaml'));
  const plan = planFromSeed(store, seed);
  store.save();
  log(c.green('② plan') + ` ${plan.epics} epics, ${plan.issues} issue contracts`);

  // 3. run
  const cfg = applyOverrides(loadConfig(ROOT), flags);
  log(c.green('③ run') + c.dim(` (generator=${cfg.generator}, ${cfg.samples} samples/issue)`));
  const results = await runAll(store, cfg, (m) => log(c.dim('   ' + m)));
  store.save();

  // 4. curate
  const { created } = curateEvalTasks(store);
  store.save();
  log(c.green('④ curate') + ` ${created.length} regression eval task(s)`);

  // 5. analyze (+create)
  const suggestions = analyzeHarness(store, computeMetrics(store));
  const newIssues = createSuggestionIssues(store, suggestions);
  store.save();
  log(c.green('⑤ analyze') + ` ${suggestions.length} suggestion(s) → ${newIssues.length} harness/eval issue(s)`);

  // 6. dashboard
  const { path: out } = writeDashboard(store);
  log(c.green('⑥ dashboard') + ` ${out}`);

  log('\n' + statusReport(store, computeMetrics(store)));
  const released = results.filter((r) => r.approved).length;
  log('\n' + c.b(`Done.`) + ` ${released}/${results.length} issues released.`);
  log(`Open the dashboard:  ${c.b('npm run dashboard')}   (or open ${path.relative(ROOT, out)})`);
  log(`Inspect the db:      ${c.dim(path.relative(ROOT, store.dbPath))}`);
  if (flags.open) openFile(out);
}

function cmdHelp(): void {
  log(`${c.b('agentops')} — local-first operating harness for coding agents

${c.b('Usage')}  npm run harness -- <command> [flags]   (or: agentops <command>)

${c.b('Commands')}
  init                 scaffold .harness/ (db + config)
  sign <spec-dir>      sign a spec's contract: pin ApprovedSpecRef (AUTH-B gate first)
  specs [<spec-dir>]   show signed specs + drift / derived status since signing
  plan [--seed F]      ingest a seed roadmap into epics + Issue Contracts
  run  [--issue ID]    drive issues: Generate → Evaluate → Repair → Release
       [--agent A] [--samples N] [--max-repairs N]
  status               pass@k / pass^k / cost summary
  dashboard [--open]   write .harness/dashboard.html
  curate               promote blocker criteria into the Eval Task Registry
  analyze [--create]   propose harness/eval improvement issues
  label --run ID --human approve|request_changes
  demo [--open]        run the entire loop on the sample roadmap
  help

${c.b('Quick start')}   ${c.green('npm run demo')}
`);
}

async function main(): Promise<void> {
  const { cmd, flags, pos } = parseArgs(process.argv);
  switch (cmd) {
    case 'init':
      return cmdInit(flags);
    case 'sign':
      return cmdSign(pos);
    case 'specs':
      return cmdSpecs(pos);
    case 'plan':
      return cmdPlan(flags);
    case 'run':
      return cmdRun(flags);
    case 'status':
      return cmdStatus();
    case 'dashboard':
      return cmdDashboard(flags);
    case 'curate':
      return cmdCurate();
    case 'analyze':
      return cmdAnalyze(flags);
    case 'label':
      return cmdLabel(flags);
    case 'demo':
      return cmdDemo(flags);
    case 'help':
    case '--help':
    case '-h':
      return cmdHelp();
    default:
      log(c.red(`Unknown command: ${cmd}`));
      cmdHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(c.red('Error:'), err instanceof Error ? err.message : err);
  process.exit(1);
});
