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
 *   intervene attest a human HOW-intervention on an issue (autonomy axis)
 *   demo      end-to-end: init + plan + run + curate + analyze + dashboard
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Verdict, emptyDB } from '../domain/schema.js';
import { Store } from '../store/store.js';
import { signRequirementDir } from '../authoring/sign-dir.js';
import { requirementsDocPath } from '../authoring/spec-doc.js';
import { recheckSpec } from '../authoring/recheck.js';
import {
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  resolveTargetRoot,
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
import { runRegressionTasks } from '../pipeline/regression.js';
import { adoptIssue } from '../pipeline/adopt.js';
import { assignIssue } from '../pipeline/assign.js';
import { declineIssue, retireEvalTask } from '../pipeline/lifecycle.js';
import { activeEvalTasks } from '../domain/eval-task.js';
import { INTERVENTION_KINDS, recordIntervention } from '../pipeline/intervene.js';
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
  const config = loadConfig(ROOT);
  const dir = pos[0];
  if (!dir) {
    log(c.red('usage: agentops sign <spec-dir>') + c.dim('   (dir with requirements.md — legacy spec.md — + acceptance.yaml)'));
    process.exit(1);
  }

  // D4: git facts are pinned against whichever repo the authoring chain currently targets
  // (config.target.repo) — the harness's own repo when absent/'.' (AC-TROOT-005 unchanged).
  const gitRoot = resolveTargetRoot(config, ROOT);
  const result = signRequirementDir(store, dir, { gitRoot });

  if (!result.ok) {
    if (result.reason === 'missing-files') {
      log(c.red(`✗ ${dir} must contain both requirements.md (legacy: spec.md) and acceptance.yaml`));
    } else if (result.reason === 'lint-failed') {
      log(c.red('✗ cannot sign — authoring lint failed:'));
      for (const e of result.errors) log(`  - ${e}`);
    } else {
      log(c.red('✗ commit the requirement doc / acceptance.yaml before signing (the signature pins committed blobs):'));
      log(c.dim(result.porcelain));
    }
    process.exit(1);
  }

  store.save();

  const approved = result.specState.approved!;
  const refs = approved.systemRefs.length;
  log(c.green('✓ signed') + ` ${c.b(dir)} @ ${c.dim(approved.signedCommitSha.slice(0, 8))}`);
  log(`  ${approved.approvedAcIds.length} AC approved · ${refs} systemRef${refs === 1 ? '' : 's'} pinned · status=${c.b('approved')}`);
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
    const specAbs = requirementsDocPath(path.resolve(ROOT, st.path));
    const accAbs = path.resolve(ROOT, st.path, 'acceptance.yaml');
    if (!fs.existsSync(specAbs) || !fs.existsSync(accAbs)) {
      log(`${c.b(st.path)}  ${c.red('broken')} ${c.dim('(requirements.md / spec.md / acceptance.yaml missing)')}`);
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
  const config = loadConfig(ROOT);
  // D4: requirement stubs materialize into whichever repo the authoring chain currently
  // targets (config.target.repo) — the harness's own docs/requirements when absent/'.'
  // (AC-TROOT-005 unchanged).
  const targetRoot = resolveTargetRoot(config, ROOT);
  const res = spawnSpecs(store, { specsRoot: path.join(targetRoot, 'docs', 'requirements') });
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

function cmdAssign(pos: string[]): void {
  const store = requireInit();
  const issueId = pos[0];
  if (!issueId) {
    log(c.red('usage: agentops assign <ISSUE-ID>') + c.dim('   (delegate a contract-drafted spec issue to the AI backend)'));
    process.exit(1);
  }
  const config = loadConfig(ROOT);
  const issue = assignIssue(store, config, issueId);
  store.save();
  log(c.green('✓ assigned') + ` ${c.b(issue.id)} ${issue.title} → ${c.b(String(issue.assignedAgent))}`);
  log(`  status=${c.b(issue.status)} · ${issue.contract!.acceptanceCriteria.length} AC ${c.dim('(now in the execution guard’s pollable queue)')}`);
  log(`\nNext: the execution loop polls it (e.g. ${c.b('npx tsx scripts/real-panel-run.ts')}).`);
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
  const { created, enriched } = curateEvalTasks(store, loadConfig(ROOT)); // bind new tasks to the current target
  store.save();
  log(c.green(`✓ curated ${created.length} eval task(s)`) + ` (registry now ${store.db.evalTasks.length})`);
  for (const t of created.slice(0, 12)) log(`  ${c.dim(t.id)} ${t.userGoal}`);
  if (created.length > 12) log(c.dim(`  …and ${created.length - 12} more`));
  if (enriched.length) log(c.green(`✓ enriched ${enriched.length} legacy task(s) with grader commands`));
}

function cmdRegress(): void {
  const store = requireInit();
  const config = loadConfig(ROOT);
  const { results, skipped } = runRegressionTasks(store, config);
  store.save();
  const fails = results.filter((r) => r.result === 'fail');
  const unverified = results.filter((r) => r.result === 'unverified');
  log(c.b(`Regression executor — ${results.length} executed, ${skipped.length} skipped`) + c.dim(` (registry ${store.db.evalTasks.length})`));
  for (const r of results) {
    const chip = r.result === 'pass' ? c.green('pass') : r.result === 'fail' ? c.red('FAIL') : c.yellow('unverified');
    log(`  ${chip}  ${r.taskId} ${c.dim(`(${r.matchedAssertions} assertion(s))`)}`);
    for (const f of r.failedNames) log(c.red(`         ✗ ${f}`));
  }
  for (const s of skipped) log(c.dim(`  skip  ${s.taskId} — ${s.reason}`));
  if (fails.length) log(`\n${c.red(`${fails.length} captured failure(s) are BACK`)} — the steering star is being violated; fix before releasing.`);
  else if (unverified.length) log(`\n${c.yellow(`${unverified.length} task(s) unverifiable`)} — no assertion carries their AC id; tag tests or refine the tasks.`);
  else if (results.length) log(`\n${c.green('all executed regressions hold')}`);
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
  if (!issueId) {
    log(c.red('usage: agentops adopt <ISSUE-ID> [--contract <yaml>]') + c.dim('   (omit --contract to confirm the proposal’s attached draft — ADR-0007)'));
    process.exit(1);
  }
  // The YAML file IS the IssueContract; an optional top-level `dependsOnSystem` rides
  // beside it and lands on the Issue (scoped design context, ARCH-execution-007).
  // Without --contract the Analyst's attached draft is used (adoptIssue validates either).
  let contract: unknown;
  let dependsOnSystem: string[] | undefined;
  const file = flags.contract;
  if (typeof file === 'string') {
    const abs = path.resolve(ROOT, file);
    if (!fs.existsSync(abs)) {
      log(c.red(`✗ no such contract file: ${file}`));
      process.exit(1);
    }
    const { dependsOnSystem: dos, ...rest } = YAML.parse(fs.readFileSync(abs, 'utf8')) as Record<string, unknown>;
    contract = rest;
    dependsOnSystem = Array.isArray(dos) ? (dos as string[]) : undefined;
  }
  const config = loadConfig(ROOT);
  const issue = adoptIssue(store, config, issueId, { contract, dependsOnSystem });
  store.save();
  log(c.green('✓ adopted') + ` ${c.b(issue.id)} ${issue.title} ${c.dim(typeof file === 'string' ? `(contract: ${file})` : '(contract: attached draft)')}`);
  log(`  status=${c.b(issue.status)} assignedAgent=${c.b(String(issue.assignedAgent))} · ${issue.contract!.acceptanceCriteria.length} AC`);
  log(`\nNext: the execution loop polls it (e.g. ${c.b('npx tsx scripts/real-panel-run.ts')}).`);
}

function cmdDecline(pos: string[], flags: Args['flags']): void {
  const store = requireInit();
  const issueId = pos[0];
  const reason = flags.reason;
  if (!issueId || typeof reason !== 'string') {
    log(c.red('usage: agentops decline <ISSUE-ID> --reason <text>') + c.dim('   (a judgment point: terminal, audited — adopt’s counterpart)'));
    process.exit(1);
  }
  // declineIssue persists on success (a judgment is a durable fact) and throws loudly otherwise.
  const issue = declineIssue(store, { issueId, reason });
  log(c.green('✓ declined') + ` ${c.b(issue.id)} ${issue.title}`);
  log(`  status=${c.b(issue.status)} · ${c.dim(String(issue.closedReason))}`);
}

function cmdRetire(pos: string[], flags: Args['flags']): void {
  const store = requireInit();
  const taskId = pos[0];
  const reason = flags.reason;
  if (!taskId || typeof reason !== 'string') {
    log(c.red('usage: agentops retire <EVAL-TASK-ID> --reason <text>') + c.dim('   (excluded from execution and its instruments; the record and capture history stay)'));
    process.exit(1);
  }
  // retireEvalTask persists on success and throws loudly otherwise.
  const task = retireEvalTask(store, { taskId, reason });
  log(c.green('✓ retired') + ` ${c.b(task.id)} ${c.dim(String(task.retiredReason))}`);
  log(c.dim(`  registry: ${activeEvalTasks(store.db.evalTasks).length} active / ${store.db.evalTasks.length} total (records are never deleted)`));
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

function cmdIntervene(pos: string[], flags: Args['flags']): void {
  const store = requireInit();
  const issueId = pos[0];
  const { kind, reason } = flags;
  if (!issueId || typeof kind !== 'string' || typeof reason !== 'string') {
    log(c.red('usage: agentops intervene <ISSUE-ID> --kind <kind> --reason <text>') + c.dim('   (attest a human HOW-intervention; judgment points are not recordable)'));
    log(c.dim(`  kinds: ${INTERVENTION_KINDS.join(' | ')}`));
    process.exit(1);
  }
  // recordIntervention persists on success (an attested fact is durable immediately)
  // and throws loudly otherwise — the top-level catch prints the reason.
  const fact = recordIntervention(store, { issueId, kind, reason });
  log(c.green('✓ intervention recorded') + ` ${c.b(fact.id)} on ${c.b(issueId)} (${fact.kind})`);
  const m = computeMetrics(store);
  if (m.interventionsPerIssue !== null && m.howNonInterventionRate !== null) {
    log(c.dim(`  autonomy axis now: ${m.interventionsPerIssue.toFixed(2)} interventions/issue · ${(m.howNonInterventionRate * 100).toFixed(1)}% intervention-free`));
  }
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
  const { created, enriched } = curateEvalTasks(store, cfg);
  store.save();
  log(c.green('④ curate') + ` ${created.length} regression eval task(s)` +
    (enriched.length ? `, ${enriched.length} legacy task(s) enriched with grader commands` : ''));

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
  assign <ISSUE-ID>    delegate a contract-drafted spec issue to the AI backend (opt-in)
  plan-tree            print the planning tree (roadmap → epic → feature → spec)
  plan [--seed F]      LEGACY: ingest a seed roadmap into epics + Issue Contracts (demo)
  run  [--issue ID]    drive issues: Generate → Evaluate → Repair → Release
       [--agent A] [--samples N] [--max-repairs N]
  status [--json]      pass@k / pass^k / cost summary (--json: machine-readable snapshot)
  dashboard [--open]   write .harness/dashboard.html
  curate               promote blocker criteria into the Eval Task Registry
  regress              execute the bound registry against the target's real graders
  analyze [--create]   propose harness/eval improvement issues
  adopt <ID> [--contract F]  confirm a proposal's WHAT → drivable; omit F to use the attached draft (ADR-0007)
  decline <ID> --reason T  retire an issue into terminal closed (judgment point, audited; never automatic)
  retire <TASK-ID> --reason T  retire a regression eval task from execution (capture history stays)
  decide <ID> approve|reject  the human review gate for a needs-human-review build
  label --run ID --human approve|request_changes
  intervene <ID> --kind K --reason T  attest a human HOW-intervention (autonomy axis)
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
    case 'assign':
      return cmdAssign(pos);
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
    case 'regress':
      return cmdRegress();
    case 'analyze':
      return cmdAnalyze(flags);
    case 'adopt':
      return cmdAdopt(pos, flags);
    case 'decline':
      return cmdDecline(pos, flags);
    case 'retire':
      return cmdRetire(pos, flags);
    case 'decide':
      return cmdDecide(pos);
    case 'label':
      return cmdLabel(flags);
    case 'intervene':
      return cmdIntervene(pos, flags);
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
