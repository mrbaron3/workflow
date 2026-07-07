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
import type { BuildArtifact } from '../../domain/artifact.js';
import type { IssueContract } from '../../domain/schema.js';
import type { TargetRepoConfig } from '../../config.js';

let reportSeq = 0;

interface CmdResult {
  ok: boolean;
  output: string;
}

function run(command: string, cwd: string): CmdResult {
  const tokens = tokenize(command);
  // sh-style leading KEY=VAL assignments (ADR-0007 I3): spawnSync uses no shell, so peel
  // them into the child env explicitly — grader commands in config can then gate
  // env-conditional suites, e.g. `ACCEPT_HARNESS=1 vitest run`.
  const env: Record<string, string> = {};
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) {
    const [key, ...rest] = tokens.shift()!.split('=');
    env[key!] = rest.join('=');
  }
  const [cmd, ...args] = tokens;
  const res = spawnSync(cmd!, args, {
    cwd,
    encoding: 'utf8',
    timeout: 1000 * 60 * 10,
    maxBuffer: 64 * 1024 * 1024,
    ...(Object.keys(env).length ? { env: { ...process.env, ...env } } : {}),
  });
  return { ok: res.status === 0, output: `${res.stdout ?? ''}\n${res.stderr ?? ''}` };
}

export interface VitestReport {
  success: boolean;
  total: number;
  passed: number;
  failedNames: string[];
  assertions: { name: string; passed: boolean }[];
}

/** Run a vitest command and parse its JSON report. Exported for the regression executor. */
export function runVitest(command: string, cwd: string): VitestReport {
  const out = path.join(os.tmpdir(), `agentops-vitest-${process.pid}-${reportSeq++}.json`);
  run(`${command} --reporter=json --outputFile=${out}`, cwd);
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

function parseVitest(json: unknown): VitestReport {
  const empty: VitestReport = { success: false, total: 0, passed: 0, failedNames: ['no vitest report'], assertions: [] };
  if (!json || typeof json !== 'object') return empty;
  const j = json as {
    success?: boolean;
    testResults?: { assertionResults?: { title?: string; fullName?: string; ancestorTitles?: string[]; status?: string }[] }[];
  };
  const assertions: { name: string; passed: boolean }[] = [];
  for (const file of j.testResults ?? []) {
    for (const a of file.assertionResults ?? []) {
      const name = a.fullName ?? [...(a.ancestorTitles ?? []), a.title ?? ''].join(' ').trim();
      assertions.push({ name, passed: a.status === 'passed' });
    }
  }
  const passed = assertions.filter((a) => a.passed).length;
  return {
    success: j.success ?? assertions.every((a) => a.passed),
    total: assertions.length,
    passed,
    failedNames: assertions.filter((a) => !a.passed).map((a) => a.name),
    assertions,
  };
}

export interface GroundOpts {
  contract: IssueContract;
  target: TargetRepoConfig;
  worktree: string;
  branch: string;
  changed: string[];
}

export interface SatisfiedResult {
  satisfied: Record<string, boolean>;
  /** unit_test ACs no assertion carries — surfaced in notes/findings, never silently passed. */
  untaggedUnitTestAcs: string[];
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
 */
export function satisfiedFromReport(contract: IssueContract, report: VitestReport | null): SatisfiedResult {
  const satisfied: Record<string, boolean> = {};
  const untaggedUnitTestAcs: string[] = [];
  for (const ac of contract.acceptanceCriteria) {
    if (!report) {
      satisfied[ac.id] = true;
      continue;
    }
    const matched = report.assertions.filter((a) => a.name.includes(ac.id));
    if (matched.length > 0) {
      satisfied[ac.id] = matched.every((a) => a.passed);
    } else if (ac.verification.method === 'unit_test') {
      satisfied[ac.id] = false;
      untaggedUnitTestAcs.push(ac.id);
    } else {
      satisfied[ac.id] = report.success;
    }
  }
  return { satisfied, untaggedUnitTestAcs };
}

/** Run the real graders against the checkout and produce a grounded BuildArtifact. */
export function groundArtifact(opts: GroundOpts): BuildArtifact {
  const g = opts.target.graders ?? {};

  const tc = g.typecheck ? run(g.typecheck, opts.worktree) : null;
  const typecheckPasses = tc ? tc.ok : true;

  const report = g.unit_tests ? runVitest(g.unit_tests, opts.worktree) : null;
  const unitTestsPass = report ? report.success : true;

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

  const { satisfied, untaggedUnitTestAcs } = satisfiedFromReport(opts.contract, report);

  const notes = [
    '[grounded] real graders ran against the worktree.',
    g.typecheck ? `typecheck: ${typecheckPasses ? 'pass' : 'FAIL'}` : 'typecheck: (skipped)',
    report ? `unit_tests: ${unitTestsPass ? 'pass' : 'FAIL'} (${report.passed}/${report.total} assertions)` : 'unit_tests: (skipped)',
    'quality.* are NOT grounded (no rubric grader) — only functional gates are real.',
  ];
  if (report && !report.success) notes.push(`vitest failures: ${report.failedNames.join('; ')}`);
  if (untaggedUnitTestAcs.length) {
    notes.push(`TDD gate: no assertion carries the AC id(s) ${untaggedUnitTestAcs.join(', ')} — write tests whose titles include them (untagged = unsatisfied).`);
  }

  return {
    branch: opts.branch,
    summary: `grounded build (${opts.changed.length} files changed)`,
    filesChanged: opts.changed,
    satisfied,
    buildPasses: typecheckPasses,
    typecheckPasses,
    unitTestsPass,
    apiTestsPass: true,
    hasTests: opts.changed.some((f) => /\.(test|spec)\./.test(f)) || (report?.total ?? 0) > 0,
    secretsLeaked: false,
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
