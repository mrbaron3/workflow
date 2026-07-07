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
import { parseSpecScenarios, parseAcceptance, parseDependsOn } from '../authoring/source.js';
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
import { loadSeedFile, planFromSeedLegacy } from '../planning/planner.js';
import {
  loadRoadmapFile,
  planRoadmap,
  spawnSpecs,
  spawnIssues,
  traceFeature,
  PlanIngestError,
} from '../planning/planning-tree.js';
import { draftContracts } from '../pipeline/contract-draft.js';
import { runAll, runIssue } from '../pipeline/coordinator.js';
import { makeRunner } from '../agents/runner.js';
import { curateEvalTasks } from '../pipeline/curator.js';
import { adoptIssue } from '../pipeline/adopt.js';
import { recordHumanDecision, type HumanDecision } from '../pipeline/execution/loop.js';
import * as YAML from 'yaml';
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
  const accText = fs.readFileSync(accAbs, 'utf8');
  const scenarios = parseSpecScenarios(fs.readFileSync(specAbs, 'utf8'));
  const verifications = parseAcceptance(accText);
  const systemRefs = parseDependsOn(accText); // pin dependsOn into ApprovedSpecRef.systemRefs

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
  const approved = buildApprovedSpecRef({ scenarios, verifications, git: facts, systemRefs });
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
  const refs = approved.systemRefs.length;
  log(c.green('✓ signed') + ` ${c.b(dir)} @ ${c.dim(facts.signedCommitSha.slice(0, 8))}`);
  log(`  ${approved.approvedAcIds.length} AC approved · ${refs} systemRef${refs === 1 ? '' : 's'} pinned · status=${c.b(status)}`);
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
  const res = planFromSeedLegacy(store, seed);
  store.save();
  log(c.green('✓ planned') + ` from ${c.dim(path.relative(ROOT, seedFile))}`);
  log(`  ${res.epics} epics, ${res.issues} issues drafted into Issue Contracts.`);
  log(`\nNext: ${c.b('agentops run')}.`);
}

function cmdPlanRoadmap(flags: Args['flags']): void {
  const store = requireInit();
  const seedFile =
    typeof flags.seed === 'string' ? path.resolve(ROOT, flags.seed) : pkgPath('seed', 'sample-plan.yaml');
  if (!fs.existsSync(seedFile)) {
    log(c.red(`Roadmap not found: ${seedFile}`));
    process.exit(1);
  }
  let res;
  try {
    res = planRoadmap(store, loadRoadmapFile(seedFile));
  } catch (err) {
    if (err instanceof PlanIngestError) {
      log(c.red('✗ roadmap rejected — nothing persisted:'));
      log(`  ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  store.save();
  log(c.green('✓ planned roadmap') + ` from ${c.dim(path.relative(ROOT, seedFile))}`);
  log(`  ${res.epics} epics, ${res.features} features in the planning tree ${c.dim(`(+${res.added.epics} epics, +${res.added.features} features)`)}`);
  if (res.descoped.length) log(`  ${c.yellow('descoped')} ${res.descoped.join(', ')} ${c.dim('(flagged, not deleted)')}`);
  log(`\nNext: ${c.b('agentops spawn-specs')} then author each spec with to-spec.`);
}

function cmdSpawnSpecs(): void {
  const store = requireInit();
  const res = spawnSpecs(store);
  store.save();
  if (res.spawned === 0) {
    log(c.dim('Nothing to spawn — every in-plan feature already has a spec. Run `agentops plan-roadmap` first.'));
    return;
  }
  log(c.green(`✓ spawned ${res.spawned} spec stub(s)`));
  for (const d of res.dirs) log(`  ${c.dim(d)}`);
  log(`\nNext: author each spec with ${c.b('to-spec')}, then ${c.b('agentops sign <spec-dir>')}.`);
}

function cmdSpawnIssues(pos: string[]): void {
  const store = requireInit();
  const dir = pos[0];
  if (!dir) {
    log(c.red('usage: agentops spawn-issues <spec-dir>') + c.dim('   (signed dir with spec.md + issues.yaml)'));
    process.exit(1);
  }
  const res = spawnIssues(store, dir);
  store.save();
  if (res.spawned === 0) {
    log(c.dim(`Nothing to spawn — ${dir} is already decomposed into issues.`));
    return;
  }
  log(c.green(`✓ spawned ${res.spawned} issue(s) from ${c.b(dir)}`));
  for (const id of res.ids) log(`  ${c.dim(id)}`);
  log(`\nNext: ${c.b('agentops run')} drives each issue: Generate → Evaluate → Repair → Release.`);
}

function cmdContractDraft(pos: string[]): void {
  const store = requireInit();
  const dir = pos[0];
  if (!dir) {
    log(c.red('usage: agentops contract-draft <spec-dir>') + c.dim('   (signed spec whose issues are spawned)'));
    process.exit(1);
  }
  const res = draftContracts(store, dir);
  store.save();
  if (res.drafted === 0) {
    log(c.dim(`Nothing to draft — no planned issues for ${dir} (already contract-drafted, or none spawned).`));
    return;
  }
  log(c.green(`✓ drafted ${res.drafted} contract(s) from ${c.b(dir)}`));
  for (const id of res.ids) log(`  ${c.dim(id)} → contract-drafted`);
  log(`\nNext: ${c.b('agentops run')} drives each issue: Generate → Evaluate → Repair → Release.`);
}

function cmdPlanTree(): void {
  const store = requireInit();
  const rm = store.db.roadmap;
  if (!rm) return void log(c.dim('No roadmap yet — run `agentops plan-roadmap`.'));
  log(c.b('Planning tree') + ` ${c.dim(rm.vision)}`);
  for (const epicId of rm.epicIds) {
    const epic = store.getEpic(epicId);
    if (!epic) continue;
    log(`${c.blue('▸')} ${c.b(epic.id)} ${epic.title} ${c.dim(`[${epic.theme}]`)}`);
    for (const fid of epic.featureIds) {
      const t = traceFeature(store, fid);
      const f = store.getFeature(fid);
      if (!f || !t) continue;
      const state = !f.inPlan ? c.yellow('descoped') : t.signed ? c.green('signed') : f.specPath ? c.blue('specced') : c.dim('planned');
      const spec = f.specPath ? c.dim(` → ${f.specPath}`) : '';
      const acs = t.approvedAcIds.length ? c.dim(` · ${t.approvedAcIds.length} AC`) : '';
      log(`   • ${f.id} ${f.title}  ${state}${spec}${acs}`);
    }
  }
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

function cmdStatus(flags: Args['flags']): void {
  const store = requireInit();
  const metrics = computeMetrics(store);
  // --json: the machine-readable snapshot (e.g. before/after an improvement issue lands).
  if (flags.json) return void log(JSON.stringify(metrics, null, 2));
  log(statusReport(store, metrics));
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

function cmdAdopt(pos: string[], flags: Args['flags']): void {
  const store = requireInit();
  const issueId = pos[0];
  const file = flags.contract;
  if (!issueId || typeof file !== 'string') {
    log(c.red('usage: agentops adopt <ISSUE-ID> --contract <yaml>') + c.dim('   (confirm a proposed harness/eval issue into drivable work — ADR-0007)'));
    process.exit(1);
  }
  const abs = path.resolve(ROOT, file);
  if (!fs.existsSync(abs)) {
    log(c.red(`✗ no such contract file: ${file}`));
    process.exit(1);
  }
  // The YAML file IS the IssueContract; an optional top-level `dependsOnSystem` rides
  // beside it and lands on the Issue (scoped design context, ARCH-execution-007).
  const raw = YAML.parse(fs.readFileSync(abs, 'utf8')) as Record<string, unknown>;
  const { dependsOnSystem, ...contract } = raw;
  const config = loadConfig(ROOT);
  const issue = adoptIssue(store, config, issueId, {
    contract,
    dependsOnSystem: Array.isArray(dependsOnSystem) ? (dependsOnSystem as string[]) : undefined,
  });
  store.save();
  log(c.green('✓ adopted') + ` ${c.b(issue.id)} ${issue.title}`);
  log(`  status=${c.b(issue.status)} assignedAgent=${c.b(String(issue.assignedAgent))} · ${issue.contract!.acceptanceCriteria.length} AC`);
  log(`\nNext: the execution loop polls it (e.g. ${c.b('npx tsx scripts/real-panel-run.ts')}).`);
}

function cmdDecide(pos: string[]): void {
  const store = requireInit();
  const issueId = pos[0];
  const decision = pos[1];
  if (!issueId || (decision !== 'approve' && decision !== 'reject')) {
    log(c.red('usage: agentops decide <ISSUE-ID> approve|reject') + c.dim('   (the human review gate — ADR-0006 G1/G3)'));
    process.exit(1);
  }
  const res = recordHumanDecision(store, issueId, decision as HumanDecision);
  store.save();
  if (!res.changed) return void log(c.yellow(`no-op:`) + ` ${issueId} is already released`);
  log(c.green('✓ decided') + ` ${c.b(issueId)}: ${decision} → status=${c.b(res.status)}`);
  if (res.labeledRunIds.length) log(c.dim(`  humanVerdict recorded on ${res.labeledRunIds.length} run(s): ${res.labeledRunIds.join(', ')}`));
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
  const plan = planFromSeedLegacy(store, seed);
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
  plan-roadmap [--seed F]  ingest a planner roadmap into the planning tree (epics + features)
  spawn-specs          materialize one authorable spec dir per in-plan feature
  spawn-issues <spec-dir>  ingest a signed spec's issues.yaml into the store (ISSUE-NNNN)
  contract-draft <spec-dir>  draft Issue Contracts from a signed spec → contract-drafted
  plan-tree            print the planning tree (roadmap → epic → feature → spec)
  plan [--seed F]      LEGACY: ingest a seed roadmap into epics + Issue Contracts (demo)
  run  [--issue ID]    drive issues: Generate → Evaluate → Repair → Release
       [--agent A] [--samples N] [--max-repairs N]
  status [--json]      pass@k / pass^k / cost summary (--json: machine-readable snapshot)
  dashboard [--open]   write .harness/dashboard.html
  curate               promote blocker criteria into the Eval Task Registry
  analyze [--create]   propose harness/eval improvement issues
  adopt <ID> --contract F  confirm a proposal's WHAT (attach contract) → drivable (ADR-0007)
  decide <ID> approve|reject  the human review gate for a needs-human-review build
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
    case 'plan-roadmap':
      return cmdPlanRoadmap(flags);
    case 'spawn-specs':
      return cmdSpawnSpecs();
    case 'spawn-issues':
      return cmdSpawnIssues(pos);
    case 'contract-draft':
      return cmdContractDraft(pos);
    case 'plan-tree':
      return cmdPlanTree();
    case 'run':
      return cmdRun(flags);
    case 'status':
      return cmdStatus(flags);
    case 'dashboard':
      return cmdDashboard(flags);
    case 'curate':
      return cmdCurate();
    case 'analyze':
      return cmdAnalyze(flags);
    case 'adopt':
      return cmdAdopt(pos, flags);
    case 'decide':
      return cmdDecide(pos);
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
