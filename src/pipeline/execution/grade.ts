/**
 * Ground a checkout into a BuildArtifact (ARCH-execution-006 feeds evaluation's grader).
 *
 * The execution layer measures the worktree with REAL commands (tsc / vitest) and turns the
 * result into the same `BuildArtifact` shape the mock produces — so evaluation's grader
 * (`gradeBuild`) and everything downstream is unchanged, but now runs on real exit codes
 * instead of self-report. This is the North Star line: evidence, not trust.
 *
 * Per-criterion satisfaction is grounded in the test report: an AC is satisfied iff the
 * tests tagged with its id all pass (harness-owned acceptance tests are the grader).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildArtifact, VerificationEvidence } from '../../domain/artifact.js';
import type { AcceptanceCriterion, IssueContract, VerificationMethod } from '../../domain/schema.js';
import { configuredGraderCommand, type TargetRepoConfig } from '../../config.js';
import { scopedAcceptEnv } from './accept.js';

let reportSeq = 0;
export const GRADER_TIMEOUT_MS = 10 * 60 * 1_000;
export const GRADER_MAX_BUFFER_BYTES = 64 * 1024 * 1_024;

export interface CmdResult {
  ok: boolean;
  output: string;
}

export interface GraderExecutionOptions {
  isolated?: boolean;
}

function isolatedCommand(
  command: string,
  args: string[],
  cwd: string,
): { command: string; args: string[]; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const safeHome = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-grader-home-')),
  );
  const safeTmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-grader-tmp-')),
  );
  const isolatedCwd = fs.realpathSync(cwd);
  const rawSystemTmp = os.tmpdir();
  const systemTmp = fs.realpathSync(os.tmpdir());
  const nodeExecutable = fs.realpathSync(process.execPath);
  let projectedDependencies: string | null = null;
  if (path.isAbsolute(command)) {
    const marker = `${path.sep}node_modules${path.sep}`;
    const markerIndex = command.lastIndexOf(marker);
    if (markerIndex >= 0) {
      const dependencyRoot = fs.realpathSync(
        command.slice(0, markerIndex + marker.length - 1),
      );
      const destination = path.join(isolatedCwd, 'node_modules');
      if (fs.existsSync(destination)) {
        throw new Error(
          `untrusted checkout already contains node_modules: ${destination}`,
        );
      }
      fs.mkdirSync(destination);
      for (const entry of fs.readdirSync(dependencyRoot)) {
        if (entry === '.vite' || entry === '.vite-temp') continue;
        fs.symlinkSync(
          path.join(dependencyRoot, entry),
          path.join(destination, entry),
        );
      }
      projectedDependencies = destination;
    }
  }
  const sandboxPortBase = 30_000 + Math.floor(Math.random() * 20_000);
  const sandboxPorts = Array.from({ length: 128 }, (_, index) => sandboxPortBase + index);
  const portLockDir = path.join(safeTmp, 'ports');
  const isolatedPath = [
    path.dirname(nodeExecutable),
    path.join(isolatedCwd, 'node_modules', '.bin'),
    '/opt/homebrew/bin',
    '/Library/Developer/CommandLineTools/usr/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(path.delimiter);
  const env: NodeJS.ProcessEnv = {
    HOME: safeHome,
    PATH: isolatedPath,
    TMPDIR: safeTmp,
    LANG: process.env.LANG ?? 'C',
  };
  const localhostPreload = path.join(
    isolatedCwd,
    `.agentops-localhost-dns-${process.pid}-${Math.random().toString(16).slice(2)}.cjs`,
  );
  fs.writeFileSync(localhostPreload, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const dns = require('node:dns');",
    "const net = require('node:net');",
    'const original = dns.promises.lookup.bind(dns.promises);',
    'dns.promises.lookup = async (hostname, options) => {',
    "  if (hostname !== 'localhost') return original(hostname, options);",
    "  if (options && options.all) return [{ address: '127.0.0.1', family: 4 }];",
    "  return { address: '127.0.0.1', family: 4 };",
    '};',
    `const allowedPorts = ${JSON.stringify(sandboxPorts)};`,
    `const lockDir = ${JSON.stringify(portLockDir)};`,
    'fs.mkdirSync(lockDir, { recursive: true });',
    'let portCursor = Math.abs(process.pid) % allowedPorts.length;',
    'function claimPort() {',
    '  for (let tried = 0; tried < allowedPorts.length; tried += 1) {',
    '    const port = allowedPorts[portCursor++ % allowedPorts.length];',
    "    try { fs.closeSync(fs.openSync(path.join(lockDir, String(port)), 'wx')); return port; } catch {}",
    '  }',
    "  throw new Error('isolated grader exhausted its local test port allowance');",
    '}',
    'const originalListen = net.Server.prototype.listen;',
    'net.Server.prototype.listen = function isolatedListen(...args) {',
    "  if (typeof args[0] === 'number' && args[0] === 0) args[0] = claimPort();",
    "  else if (args[0] && typeof args[0] === 'object' && args[0].port === 0) {",
    '    args[0] = { ...args[0], port: claimPort() };',
    '  }',
    '  return originalListen.apply(this, args);',
    '};',
    '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });
  // Vite resolves localhost while starting Vitest even when no browser/API test
  // needs network. Resolve only that literal in-process so the sandbox can keep
  // denying every network syscall, including DNS and loopback connections.
  env.NODE_OPTIONS = `--require=${localhostPreload}`;
  if (process.platform !== 'darwin') {
    fs.rmSync(localhostPreload, { force: true });
    fs.rmSync(safeHome, { recursive: true, force: true });
    fs.rmSync(safeTmp, { recursive: true, force: true });
    throw new Error('untrusted grader isolation is unavailable on this platform');
  }
  const quoted = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const resolveExecutable = (value: string): string | null => {
    if (path.isAbsolute(value)) return fs.existsSync(value) ? fs.realpathSync(value) : null;
    for (const entry of (process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter)) {
      const candidate = path.join(entry, value);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.realpathSync(candidate);
      } catch {
        // Keep searching the operator-owned PATH.
      }
    }
    return null;
  };
  const nodeRuntimeRoot = path.dirname(path.dirname(nodeExecutable));
  const executable = resolveExecutable(command);
  const trustedReadRoots = new Set<string>([nodeRuntimeRoot]);
  if (executable && !executable.startsWith(`${isolatedCwd}${path.sep}`)) {
    let cursor = path.dirname(executable);
    while (cursor !== path.dirname(cursor) && path.basename(cursor) !== 'node_modules') {
      cursor = path.dirname(cursor);
    }
    trustedReadRoots.add(path.basename(cursor) === 'node_modules' ? cursor : path.dirname(executable));
  }
  const trustedReadRules = [...trustedReadRoots]
    .map((root) => `(subpath "${quoted(root)}")`)
    .join(' ');
  const accessibleRoots = [
    ...trustedReadRoots,
    isolatedCwd,
    safeHome,
    safeTmp,
  ];
  const ancestorRules = accessibleRoots
    .map((root) => `(path-ancestors "${quoted(root)}")`)
    .join(' ');
  const localTestPorts = sandboxPorts
    .map((port) => `(local tcp "localhost:${port}")`)
    .join(' ');
  const remoteTestPorts = sandboxPorts
    .map((port) => `(remote tcp "localhost:${port}")`)
    .join(' ');
  const profile = [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    '(allow process*)',
    '(allow signal (target children))',
    '(allow sysctl-read)',
    `(allow file-read-metadata file-test-existence ${ancestorRules})`,
    '(deny file-read* file-test-existence',
    `  (require-all (subpath "${quoted(systemTmp)}")`,
    `    (require-not (subpath "${quoted(isolatedCwd)}"))`,
    `    (require-not (subpath "${quoted(safeHome)}"))`,
    `    (require-not (subpath "${quoted(safeTmp)}"))`,
    `    (require-not (path-ancestors "${quoted(isolatedCwd)}"))`,
    `    (require-not (path-ancestors "${quoted(safeHome)}"))`,
    `    (require-not (path-ancestors "${quoted(safeTmp)}"))))`,
    '(deny file-write*',
    `  (require-all (subpath "${quoted(systemTmp)}")`,
    `    (require-not (subpath "${quoted(isolatedCwd)}"))`,
    `    (require-not (subpath "${quoted(safeHome)}"))`,
    `    (require-not (subpath "${quoted(safeTmp)}"))))`,
    '(allow file-read* file-test-existence (subpath "/System") (subpath "/usr") (subpath "/Library") (subpath "/opt")',
    `  ${trustedReadRules} (subpath "${quoted(isolatedCwd)}") (subpath "${quoted(safeHome)}") (subpath "${quoted(safeTmp)}"))`,
    `(allow file-write* (subpath "${quoted(isolatedCwd)}") (subpath "${quoted(safeHome)}") (subpath "${quoted(safeTmp)}"))`,
    ...(rawSystemTmp === systemTmp ? [] : [
      '(deny file-read* file-test-existence',
      `  (require-all (subpath "${quoted(rawSystemTmp)}")`,
      `    (require-not (subpath "${quoted(isolatedCwd)}"))`,
      `    (require-not (subpath "${quoted(safeHome)}"))`,
      `    (require-not (subpath "${quoted(safeTmp)}"))`,
      `    (require-not (path-ancestors "${quoted(isolatedCwd)}"))`,
      `    (require-not (path-ancestors "${quoted(safeHome)}"))`,
      `    (require-not (path-ancestors "${quoted(safeTmp)}"))))`,
      '(deny file-write*',
      `  (require-all (subpath "${quoted(rawSystemTmp)}")`,
      `    (require-not (subpath "${quoted(isolatedCwd)}"))`,
      `    (require-not (subpath "${quoted(safeHome)}"))`,
      `    (require-not (subpath "${quoted(safeTmp)}"))))`,
    ]),
    // Node's trusted preload rewrites ephemeral test listeners into this
    // per-grader random set. Existing operator services and every external
    // target remain unreachable.
    `(allow network-bind network-inbound ${localTestPorts})`,
    `(allow network-outbound ${remoteTestPorts})`,
  ].join('\n');
  return {
    command: '/usr/bin/sandbox-exec',
    args: ['-p', profile, command, ...args],
    env,
    cleanup: () => {
      if (fs.existsSync(localhostPreload)) fs.rmSync(localhostPreload, { force: true });
      if (projectedDependencies && fs.existsSync(projectedDependencies)) {
        fs.rmSync(projectedDependencies, { recursive: true, force: true });
      }
      fs.rmSync(safeHome, { recursive: true, force: true });
      fs.rmSync(safeTmp, { recursive: true, force: true });
    },
  };
}

export function runGraderCommand(
  command: string,
  cwd: string,
  extraEnv: Record<string, string> = {},
  options: GraderExecutionOptions = {},
): CmdResult {
  const tokens = tokenize(command);
  // sh-style leading KEY=VAL assignments (ADR-0007 I3): spawnSync uses no shell, so peel
  // them into the child env explicitly — grader commands in config can then gate
  // env-conditional suites, e.g. `ACCEPT_HARNESS=1 vitest run`. The command's own prefix
  // wins over injected extraEnv: an explicit captured spelling outranks harness injection.
  const env: Record<string, string> = { ...extraEnv };
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) {
    const [key, ...rest] = tokens.shift()!.split('=');
    env[key!] = rest.join('=');
  }
  const [cmd, ...args] = tokens;
  const execution = options.isolated
    ? isolatedCommand(cmd!, args, cwd)
    : { command: cmd!, args, env: process.env, cleanup: () => {} };
  const childEnv = options.isolated
    ? {
      ...execution.env,
      ...Object.fromEntries(Object.entries(env).filter(([name]) =>
        name === 'ACCEPT_HARNESS' || name === 'AGENTOPS_ACTIVE_ISSUE')),
    }
    : { ...execution.env, ...env };
  const res = spawnSync(execution.command, execution.args, {
    cwd,
    encoding: 'utf8',
    timeout: GRADER_TIMEOUT_MS,
    maxBuffer: GRADER_MAX_BUFFER_BYTES,
    env: childEnv,
  });
  execution.cleanup();
  const diagnostic = res.error
    ? `\nspawn error: ${res.error.message}`
    : res.signal
      ? `\nterminated by signal: ${res.signal}`
      : res.status === null
        ? '\nprocess exited without a status'
        : res.status === 0
          ? ''
          : `\nexit status: ${res.status}`;
  return {
    ok: res.status === 0,
    output: `${res.stdout ?? ''}\n${res.stderr ?? ''}${diagnostic}`,
  };
}

export interface VitestReport {
  success: boolean;
  total: number;
  passed: number;
  failedNames: string[];
  /** `skipped` marks never-run assertions (SKIP_STATUSES) — dormant, not failed. */
  assertions: { name: string; passed: boolean; skipped?: boolean }[];
}

/** Run a vitest command and parse its JSON report. Exported for the regression executor. */
export function runVitest(
  command: string,
  cwd: string,
  extraEnv?: Record<string, string>,
  options?: GraderExecutionOptions,
): VitestReport {
  const out = path.join(
    options?.isolated ? cwd : os.tmpdir(),
    `.agentops-vitest-${process.pid}-${reportSeq++}.json`,
  );
  const configLoader = options?.isolated && !command.includes('--configLoader')
    ? ' --configLoader=runner'
    : '';
  runGraderCommand(
    `${command}${configLoader} --reporter=json --outputFile=${out}`,
    cwd,
    extraEnv,
    options,
  );
  let json: unknown = null;
  try {
    if (fs.existsSync(out)) json = JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch {
    json = null;
  } finally {
    if (fs.existsSync(out)) fs.rmSync(out, { force: true });
  }
  return parseVitest(json);
}

/** The vitest json-reporter statuses meaning "never ran" (vs pass/fail verdicts). */
const SKIP_STATUSES = new Set(['skipped', 'pending', 'todo', 'disabled']);

function parseVitest(json: unknown): VitestReport {
  const empty: VitestReport = { success: false, total: 0, passed: 0, failedNames: ['no vitest report'], assertions: [] };
  if (!json || typeof json !== 'object') return empty;
  const j = json as {
    success?: boolean;
    testResults?: { assertionResults?: { title?: string; fullName?: string; ancestorTitles?: string[]; status?: string }[] }[];
  };
  const assertions: VitestReport['assertions'] = [];
  for (const file of j.testResults ?? []) {
    for (const a of file.assertionResults ?? []) {
      const name = a.fullName ?? [...(a.ancestorTitles ?? []), a.title ?? ''].join(' ').trim();
      assertions.push({ name, passed: a.status === 'passed', skipped: SKIP_STATUSES.has(a.status ?? '') });
    }
  }
  const passed = assertions.filter((a) => a.passed).length;
  // Dormancy is not failure (gate pin, ⑭ release closure): a never-ran assertion neither
  // fails the fallback verdict nor lands in failedNames — the `vitest failures:` note must
  // name real reds only, never guards issue-scoped activation left dormant.
  return {
    success: j.success ?? assertions.every((a) => a.passed || a.skipped),
    total: assertions.length,
    passed,
    failedNames: assertions.filter((a) => !a.passed && !a.skipped).map((a) => a.name),
    assertions,
  };
}

export interface GroundOpts {
  contract: IssueContract;
  target: TargetRepoConfig;
  worktree: string;
  branch: string;
  changed: string[];
  /**
   * The driven issue: scopes AC-id matching to its assertions (assertionsForCriterion)
   * and activates only ITS pre-placed acceptance guards (scopedAcceptEnv → grader child env).
   */
  issueId?: string;
  /** Repository-discovered heads are attacker-controlled until review completes. */
  untrusted?: boolean;
}

export interface SatisfiedResult {
  satisfied: Record<string, boolean>;
  /** unit_test ACs no assertion carries — surfaced in notes/findings, never silently passed. */
  untaggedUnitTestAcs: string[];
  /**
   * ACs whose EVERY matching assertion is dormant (never ran): the driven issue's own
   * guard failed to activate — e.g. a pre-placed guard still gating on the legacy
   * full-activation spelling under scoped grading. Unsatisfied AND named in notes,
   * so the red is diagnosable instead of silent (ARCH-execution-015).
   */
  dormantAcs: string[];
}

/** An assertion title explicitly scoped to SOME issue (`ISSUE-XXXX/AC-N …`); captures the issue id. */
const SCOPED_TAG = /(ISSUE-[^/\s]+)\//;

/**
 * The assertions that verify one criterion — the ONE matching rule grading and the
 * regression executor share. AC ids are issue-scoped names ('AC-1' recurs in every
 * contract), so bare substring matching bleeds across issues — grounded 2026-07-07:
 * ISSUE-0004's baseline-red AC-1 acceptance assertion false-failed ISSUE-0003's holding
 * regression task. Rule: assertions tagged `<issueId>/<acId>` win when any exist; the
 * bare fallback (legacy suites) never admits an assertion explicitly scoped to some issue.
 */
export function assertionsForCriterion(
  assertions: VitestReport['assertions'],
  acId: string,
  issueId?: string | null,
): VitestReport['assertions'] {
  if (issueId) {
    const scoped = assertions.filter((a) => a.name.includes(`${issueId}/${acId}`));
    if (scoped.length > 0) return scoped;
  }
  return assertions.filter((a) => a.name.includes(acId) && !SCOPED_TAG.test(a.name));
}

/**
 * Per-criterion satisfaction from the test report (TDD gate). An AC is satisfied iff the
 * assertions whose titles carry its AC id all pass. When a report EXISTS but no assertion
 * carries a unit_test AC's id, the AC is NOT satisfied — the old suite-green fallback let a
 * generator skip AC-tagged tests entirely and still pass, which gutted test-first discipline
 * (the generator role prompt mandates the tagging; this makes the mandate mechanical).
 * Non-unit_test methods (e.g. playwright) keep the fallback: vitest cannot verify them.
 * With no report at all (no unit_tests grader configured) everything falls back to true —
 * grading without a test grader is an operator choice, not the agent's silent pass.
 * `issueId` scopes the match (assertionsForCriterion) so grading over the whole suite
 * never picks up another issue's identically-named criteria.
 */
export function satisfiedFromReport(contract: IssueContract, report: VitestReport | null, issueId?: string | null): SatisfiedResult {
  const satisfied: Record<string, boolean> = {};
  const untaggedUnitTestAcs: string[] = [];
  const dormantAcs: string[] = [];
  for (const ac of contract.acceptanceCriteria) {
    if (!report) {
      satisfied[ac.id] = true;
      continue;
    }
    const matched = assertionsForCriterion(report.assertions, ac.id, issueId);
    if (matched.length > 0) {
      satisfied[ac.id] = matched.every((a) => a.passed);
      // every matching assertion never ran → the own guard did not activate: keep the
      // AC unsatisfied but NAME the gap (a bare red with no reason is a silent trap).
      if (matched.every((a) => a.skipped)) dormantAcs.push(ac.id);
    } else if (ac.verification.method === 'unit_test') {
      satisfied[ac.id] = false;
      untaggedUnitTestAcs.push(ac.id);
    } else {
      satisfied[ac.id] = report.success;
    }
  }
  return { satisfied, untaggedUnitTestAcs, dormantAcs };
}

/**
 * Notes for pre-placed guards another issue owns that stayed dormant under this grading
 * (AC-SCOPED-003, never-silent — ARCH-execution-015): one line per owning issue, naming
 * it and the reason. Derived from the report facts — assertions that never ran and carry
 * some OTHER issue's scope tag — and used for REPORTING only; activation itself is
 * decided by each guard's declared `acceptsIssue(...)` call, never by name matching.
 */
export function dormantGuardNotes(assertions: VitestReport['assertions'], drivenIssueId: string): string[] {
  const byOwner = new Map<string, number>();
  for (const a of assertions) {
    const owner = a.skipped ? SCOPED_TAG.exec(a.name)?.[1] : undefined;
    if (owner && owner !== drivenIssueId) byOwner.set(owner, (byOwner.get(owner) ?? 0) + 1);
  }
  return [...byOwner].map(
    ([owner, n]) =>
      `pre-placed guards not activated: ${owner} (${n} skipped assertion${n === 1 ? '' : 's'}) — ` +
      `owned by an issue other than the driven ${drivenIssueId}; issue-scoped activation left them dormant.`,
  );
}

/** Run the real graders against the checkout and produce a grounded BuildArtifact. */
export function groundArtifact(opts: GroundOpts): BuildArtifact {
  const acsByMethod = new Map<VerificationMethod, AcceptanceCriterion[]>();
  for (const ac of opts.contract.acceptanceCriteria) {
    const group = acsByMethod.get(ac.verification.method) ?? [];
    group.push(ac);
    acsByMethod.set(ac.verification.method, group);
  }

  const typecheckCommand = configuredGraderCommand(opts.target, 'typecheck');
  const execution = { isolated: opts.untrusted === true };
  const tc = typecheckCommand ? runGraderCommand(typecheckCommand, opts.worktree, {}, execution) : null;

  // Issue-scoped activation (AC-SCOPED-001): a driven issue's grading activates only ITS
  // pre-placed guards — the scoped env is injected here so other in-flight issues'
  // baseline-red guards stay dormant. Without issueId nothing is injected (additive), and
  // a command's own full-activation prefix still wins inside `run` (spelling unchanged).
  const unitTestCommand = configuredGraderCommand(opts.target, 'unit_test');
  const report = unitTestCommand
    ? runVitest(
      unitTestCommand,
      opts.worktree,
      opts.issueId ? scopedAcceptEnv(opts.issueId) : undefined,
      execution,
    )
    : null;

  const inScope = (f: string) =>
    opts.contract.scope.include.length === 0 || opts.contract.scope.include.some((p) => globMatch(p, f));
  // scope.exclude carves exceptions out of include: a match is a violation even when include also matches.
  const excluded = (f: string) => opts.contract.scope.exclude.some((p) => globMatch(p, f));
  const protectedHit = opts.changed.filter((f) =>
    (opts.target.protectedPaths ?? []).some((p) => f === p || f.startsWith(p.replace(/\*+$/, ''))),
  );
  const scopeViolations = [
    ...protectedHit,
    ...opts.changed.filter((f) => (!inScope(f) || excluded(f)) && !protectedHit.includes(f)),
  ];

  const { satisfied, untaggedUnitTestAcs, dormantAcs } = satisfiedFromReport(opts.contract, report, opts.issueId);
  const verificationEvidence: Record<string, VerificationEvidence> = {};
  const missingGraderAcs: string[] = [];
  const evidenceOutput = (output: string): string => output.trim().slice(-8000);

  for (const ac of opts.contract.acceptanceCriteria) {
    const method = ac.verification.method;
    if (method === 'unit_test') {
      if (!report) {
        satisfied[ac.id] = false;
        missingGraderAcs.push(ac.id);
      }
      verificationEvidence[ac.id] = {
        method,
        command: unitTestCommand ?? null,
        passed: satisfied[ac.id] ?? false,
        output: report
          ? `${report.passed}/${report.total} assertions; failures=${report.failedNames.join('; ') || '(none)'}`
          : 'no configured grader command for unit_test',
      };
      continue;
    }
    if (method === 'typecheck') {
      satisfied[ac.id] = tc?.ok ?? false;
      if (!tc) missingGraderAcs.push(ac.id);
      verificationEvidence[ac.id] = {
        method,
        command: typecheckCommand ?? null,
        passed: satisfied[ac.id]!,
        output: tc ? evidenceOutput(tc.output) : 'no configured grader command for typecheck',
      };
      continue;
    }
    if (method === 'scope_check') {
      satisfied[ac.id] = scopeViolations.length === 0;
      verificationEvidence[ac.id] = {
        method,
        command: null,
        passed: satisfied[ac.id]!,
        output: scopeViolations.length ? `scope violations: ${scopeViolations.join(', ')}` : 'intrinsic scope check passed',
      };
      continue;
    }

    const command = configuredGraderCommand(opts.target, method);
    if (!command) {
      satisfied[ac.id] = false;
      missingGraderAcs.push(ac.id);
      verificationEvidence[ac.id] = {
        method,
        command: null,
        passed: false,
        output: `no configured grader command for ${method}`,
      };
      continue;
    }
    const result = runGraderCommand(command, opts.worktree, {
      ...(opts.issueId ? scopedAcceptEnv(opts.issueId) : {}),
      AGENTOPS_AC_ID: ac.id,
      AGENTOPS_ISSUE_ID: opts.issueId ?? '',
      AGENTOPS_VERIFICATION_METHOD: method,
      AGENTOPS_EXPECTED_JSON: JSON.stringify(ac.verification.expected),
    });
    satisfied[ac.id] = result.ok;
    verificationEvidence[ac.id] = {
      method,
      command,
      passed: result.ok,
      output: evidenceOutput(result.output),
    };
  }

  const methodPasses = (method: VerificationMethod): boolean =>
    (acsByMethod.get(method) ?? []).every((ac) => satisfied[ac.id] === true);
  const typecheckPasses = tc ? tc.ok : !acsByMethod.has('typecheck');
  const unitTestsPass = report ? report.success : !acsByMethod.has('unit_test');
  const buildPasses = typecheckPasses && methodPasses('build');
  const apiTestsPass = methodPasses('api_test');
  const secretsLeaked = !methodPasses('secrets_scan');

  // Dormant assertions never ran — count them so the pass note reads honestly under
  // scoped grading (12/40 with 28 dormant is a healthy build, not a mostly-failing one).
  const dormantCount = report ? report.assertions.filter((a) => a.skipped).length : 0;
  const notes = [
    '[grounded] real graders ran against the worktree.',
    typecheckCommand ? `typecheck: ${typecheckPasses ? 'pass' : 'FAIL'}` : 'typecheck: (skipped)',
    report
      ? `unit_tests: ${unitTestsPass ? 'pass' : 'FAIL'} (${report.passed}/${report.total} assertions${dormantCount ? `, ${dormantCount} dormant` : ''})`
      : 'unit_tests: (skipped)',
    'quality.* are NOT grounded (no rubric grader) — only functional gates are real.',
  ];
  if (report && !report.success) notes.push(`vitest failures: ${report.failedNames.join('; ')}`);
  // Dormant guards surface with owner + reason (AC-SCOPED-003) — only under scoped grading;
  // an unscoped run (no issueId) never attributes skips, and no dormant guards → no listing.
  if (report && opts.issueId) notes.push(...dormantGuardNotes(report.assertions, opts.issueId));
  if (untaggedUnitTestAcs.length) {
    notes.push(`TDD gate: no assertion carries the AC id(s) ${untaggedUnitTestAcs.join(', ')} — write tests whose titles include them (untagged = unsatisfied).`);
  }
  if (dormantAcs.length) {
    notes.push(
      `activation gap: AC ${dormantAcs.join(', ')} matched only dormant assertions — the driven issue's own pre-placed guard never activated (check its acceptsIssue declaration); unsatisfied, never silent.`,
    );
  }
  if (missingGraderAcs.length) {
    notes.push(
      `verification gate: no configured command for AC(s) ${missingGraderAcs.join(', ')} — unsatisfied (fail-closed).`,
    );
  }
  for (const [acId, evidence] of Object.entries(verificationEvidence)) {
    if (!evidence.passed && evidence.output) notes.push(`${acId}/${evidence.method}: ${evidence.output}`);
  }

  return {
    branch: opts.branch,
    summary: `grounded build (${opts.changed.length} files changed)`,
    filesChanged: opts.changed,
    satisfied,
    verificationEvidence,
    buildPasses,
    typecheckPasses,
    unitTestsPass,
    apiTestsPass,
    hasTests: opts.changed.some((f) => /\.(test|spec)\./.test(f))
      || (report?.total ?? 0) > 0
      || ['api_test', 'playwright'].some((method) => acsByMethod.has(method as VerificationMethod)),
    secretsLeaked,
    scopeViolations,
    quality: { codeQuality: 0.7, testQuality: 0.7, ux: 0.7, accessibility: 0.7 },
    notes,
  };
}

function tokenize(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? '');
  return out;
}

function globMatch(pattern: string, file: string): boolean {
  const rx = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, ' ')
        .replace(/\*/g, '[^/]*')
        .replace(/ /g, '.*') +
      '$',
  );
  return rx.test(file);
}
