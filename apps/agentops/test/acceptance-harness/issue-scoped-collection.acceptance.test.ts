/**
 * Env-gated acceptance grader for ISSUE-0022 — spec
 * docs/specs/issue-scoped-acceptance-collection (AC-SCOPED-001..004, FEAT-009 / EPIC-04,
 * the D3 omnibus-gate closure: suite-wide collection forced the first driven issue to
 * implement OTHER issues' pre-placed payloads — ISSUE-0019 carried 0020/0021).
 *
 * This began as the env-gated acceptance grader for the drive — red at baseline BY
 * DESIGN, collected only under ACCEPT_HARNESS=1 (ADR-0007 I3), with two invariance pins
 * correctly green pre-implementation (own-red-still-fails / no-dormant-no-listing).
 * The build was human-approved and released (2026-07-09, ⑭): accept.ts is the single
 * home for activation semantics, grade.ts injects the driven issue's scoped env and
 * reports dormancy, real-run-self.ts dropped the suite-wide full-activation prefix.
 * skipIf dropped: permanent guard, protectedPaths. The seam module now exists, so the
 * computed-specifier lazy imports (⑨ rule for unresolved seams) became static imports.
 *
 * Gate-condition pins (⑭ conditional approval — panel attempt-2 persisted findings,
 * implemented by the eval owner in the same closure, mutation-verified):
 *   - failedNames / the `vitest failures:` note exclude dormancy (a dormant guard is
 *     not a failure, and must never be named as one);
 *   - the no-`success`-field fallback treats dormancy as non-failure;
 *   - the driven issue's own all-dormant guard fails LOUD: unsatisfied AND an
 *     `activation gap` note names the AC (a bare red with no reason is a silent trap —
 *     the legacy-spelling-guard-under-scoped-grading migration case);
 *   - every never-ran reporter status counts as dormant (skipped/pending/todo/disabled);
 *   - a command's own scoped prefix outranks the injected driven issue, and an explicit
 *     full-activation prefix outranks scoped injection (captured spellings win);
 *   - the regression executor keeps a dormant matched assertion LOUD (fail, no silent pass).
 *
 * The fake grader below writes a crafted vitest JSON report to the --outputFile path
 * runVitest appends, and dumps its own env — so every collection branch is decided
 * deterministically, with no nested real vitest run. The `ACCEPT_HARNESS=` (empty)
 * command prefix neutralizes any ambient full-activation flag (e.g. a whole-registry
 * regress run) so scoped-only activation stays decidable; empty-is-off is pinned.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dormantGuardNotes, groundArtifact } from '../../src/pipeline/execution/grade.js';
import { acceptsIssue, scopedAcceptEnv, SCOPED_ACCEPT_ENV } from '../../src/pipeline/execution/accept.js';
import { runRegressionTasks } from '../../src/pipeline/regression.js';
import { Store, nowISO } from '../../src/store/store.js';
import { EvalTask, type IssueContract } from '../../src/domain/schema.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../../src/config.js';

const contract: IssueContract = {
  productGoal: 'issue-scoped acceptance collection',
  userStory: 'each build is gated on its own issue delta only',
  scope: { include: [], exclude: [] },
  acceptanceCriteria: [
    { id: 'AC-1', severity: 'blocker', behavior: 'own guard green', verification: { method: 'unit_test', expected: ['x'] } },
  ],
  redLines: [],
};

/** Crafted vitest report: own guard green, another issue's pre-placed guards dormant. */
const REPORT_DORMANT = {
  success: true,
  testResults: [
    {
      assertionResults: [
        { fullName: 'ISSUE-A/AC-1 own pre-placed guard is green', status: 'passed' },
        { fullName: 'baseline suite stays green', status: 'passed' },
        { fullName: 'ISSUE-B/AC-1 other pre-placed guard left dormant', status: 'skipped' },
        { fullName: 'ISSUE-B/AC-2 other pre-placed guard left dormant too', status: 'pending' },
      ],
    },
  ],
};

/** Crafted report: the driven issue's OWN guard is red — the gate must stay strict. */
const REPORT_OWN_RED = {
  success: false,
  testResults: [
    {
      assertionResults: [
        { fullName: 'ISSUE-A/AC-1 own pre-placed guard is red', status: 'failed' },
        { fullName: 'baseline suite stays green', status: 'passed' },
      ],
    },
  ],
};

/** Crafted report: nothing dormant — the listing must stay silent. */
const REPORT_ALL_ACTIVE = {
  success: true,
  testResults: [
    {
      assertionResults: [
        { fullName: 'ISSUE-A/AC-1 own pre-placed guard is green', status: 'passed' },
        { fullName: 'baseline suite stays green', status: 'passed' },
      ],
    },
  ],
};

/** Gate pin: own red AND foreign dormancy in one report — the failure note must not mix them. */
const REPORT_OWN_RED_WITH_DORMANT = {
  success: false,
  testResults: [
    {
      assertionResults: [
        { fullName: 'ISSUE-A/AC-1 own pre-placed guard is red', status: 'failed' },
        { fullName: 'baseline suite stays green', status: 'passed' },
        { fullName: 'ISSUE-B/AC-1 other pre-placed guard left dormant', status: 'todo' },
      ],
    },
  ],
};

/** Gate pin: reporter emitted no overall `success` — the fallback must not count dormancy as failure. */
const REPORT_NO_SUCCESS_FIELD = {
  testResults: [
    {
      assertionResults: [
        { fullName: 'ISSUE-A/AC-1 own pre-placed guard is green', status: 'passed' },
        { fullName: 'ISSUE-B/AC-1 other pre-placed guard left dormant', status: 'skipped' },
      ],
    },
  ],
};

/** Gate pin: the driven issue's OWN guard never activated (legacy-spelling migration case). */
const REPORT_OWN_DORMANT = {
  success: true,
  testResults: [
    {
      assertionResults: [
        { fullName: 'ISSUE-A/AC-1 own pre-placed guard left dormant', status: 'disabled' },
        { fullName: 'baseline suite stays green', status: 'passed' },
      ],
    },
  ],
};

/**
 * A grader command that dumps its child env and emits the crafted report to the
 * --outputFile runVitest appends. `envPrefix` defaults to neutralizing any ambient
 * ACCEPT_HARNESS so scoped-only activation is decidable inside a gated run.
 */
function makeFixture(report: unknown, envPrefix = 'ACCEPT_HARNESS= ') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-scoped-'));
  const script = path.join(dir, 'fake-grader.cjs');
  fs.writeFileSync(
    script,
    [
      "const fs=require('fs');",
      "const out=(process.argv.find(a=>a.startsWith('--outputFile='))||'').slice('--outputFile='.length);",
      'fs.writeFileSync(process.env.ENV_DUMP,JSON.stringify(process.env));',
      "if(out)fs.writeFileSync(out,fs.readFileSync(process.env.REPORT_JSON,'utf8'));",
    ].join('\n'),
  );
  const reportPath = path.join(dir, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report));
  const envDump = path.join(dir, 'env.json');
  return {
    dir,
    command: `${envPrefix}REPORT_JSON=${reportPath} ENV_DUMP=${envDump} node ${script}`,
    readEnv: () => JSON.parse(fs.readFileSync(envDump, 'utf8')) as Record<string, string>,
  };
}

function ground(fixture: ReturnType<typeof makeFixture>, issueId?: string) {
  return groundArtifact({
    contract,
    target: { repo: '.', graders: { unit_tests: fixture.command } },
    worktree: fixture.dir,
    branch: 'accept',
    changed: [],
    ...(issueId ? { issueId } : {}),
  });
}

describe('issue-scoped acceptance collection (ISSUE-0022)', () => {
  it('ISSUE-0022/AC-SCOPED-001 single-home predicate: scoped activation admits only the declared issue, full activation admits all, empty flag is off', () => {
    const env = scopedAcceptEnv('ISSUE-A');
    expect(acceptsIssue('ISSUE-A', env)).toBe(true);
    expect(acceptsIssue('ISSUE-B', env)).toBe(false);
    expect(acceptsIssue('ISSUE-B', { ACCEPT_HARNESS: '1' })).toBe(true);
    expect(acceptsIssue('ISSUE-A', {})).toBe(false);
    expect(acceptsIssue('ISSUE-A', { ACCEPT_HARNESS: '' })).toBe(false);
  });

  it("ISSUE-0022/AC-SCOPED-001 grading a driven issue injects its scoped activation into the grader child env and passes on the issue's own green delta", () => {
    const fx = makeFixture(REPORT_DORMANT);
    const artifact = ground(fx, 'ISSUE-A');
    // the child env the real grader command saw: scoped to the driven issue only
    const childEnv = fx.readEnv();
    expect(acceptsIssue('ISSUE-A', childEnv)).toBe(true);
    expect(acceptsIssue('ISSUE-B', childEnv)).toBe(false);
    // own guards + baseline green while ISSUE-B's guards stay dormant → the gate passes
    expect(artifact.unitTestsPass).toBe(true);
    expect(artifact.satisfied['AC-1']).toBe(true);
  });

  it("ISSUE-0022/AC-SCOPED-001 the driven issue's own red still fails the gate (scoping never exempts the driven issue)", () => {
    const fx = makeFixture(REPORT_OWN_RED);
    const artifact = ground(fx, 'ISSUE-A');
    expect(artifact.unitTestsPass).toBe(false);
    expect(artifact.satisfied['AC-1']).toBe(false);
  });

  it('ISSUE-0022/AC-SCOPED-002 activation resolves per declared guard, not per file: two declarations sharing one file get independent answers', () => {
    // one guard FILE hosting declarations for two issues (the 0019/0020 shared-file
    // convention): under an env scoped to ISSUE-A, the two skipIf conditions evaluated
    // in that same file must diverge — a file-level all-or-nothing cannot satisfy this.
    const env = scopedAcceptEnv('ISSUE-A');
    const answers = [acceptsIssue('ISSUE-A', env), acceptsIssue('ISSUE-B', env)];
    expect(answers).toEqual([true, false]);
  });

  it('ISSUE-0022/AC-SCOPED-003 dormant pre-placed guards are listed in the grading notes with the owning issue and the reason', () => {
    const fx = makeFixture(REPORT_DORMANT);
    const artifact = ground(fx, 'ISSUE-A');
    const listing = artifact.notes.filter((n) => /not activated/i.test(n));
    expect(listing.length).toBeGreaterThan(0);
    // owning issue attributed and the reason references the driven-issue scoping
    expect(listing.some((n) => n.includes('ISSUE-B') && /driv/i.test(n))).toBe(true);
  });

  it('ISSUE-0022/AC-SCOPED-003 no dormant guards → no non-activation listing (the listing is only for the non-empty case)', () => {
    const fx = makeFixture(REPORT_ALL_ACTIVE);
    const artifact = ground(fx, 'ISSUE-A');
    expect(artifact.notes.some((n) => /not activated/i.test(n))).toBe(false);
  });

  it('ISSUE-0022/AC-SCOPED-004 an explicit full-activation command prefix keeps activating every declared guard (captured regress commands unchanged)', () => {
    const fx = makeFixture(REPORT_ALL_ACTIVE, 'ACCEPT_HARNESS=1 ');
    const artifact = ground(fx); // no driven issue — e.g. a regress-captured command
    const childEnv = fx.readEnv();
    expect(acceptsIssue('ISSUE-A', childEnv)).toBe(true);
    expect(acceptsIssue('ISSUE-B', childEnv)).toBe(true);
    expect(artifact.unitTestsPass).toBe(true);
  });

  it('ISSUE-0022/AC-SCOPED-004 grading without a driven issue injects no scoped activation (additive backward compat)', () => {
    const fx = makeFixture(REPORT_ALL_ACTIVE);
    const artifact = ground(fx); // no issueId, no full-activation prefix
    const childEnv = fx.readEnv();
    expect(acceptsIssue('ISSUE-A', childEnv)).toBe(false);
    expect(artifact.unitTestsPass).toBe(true);
  });

  // --- gate-condition pins (⑭ conditional approval; see header) --------------------

  it('ISSUE-0022/AC-SCOPED-001 gate pin: an own red failure note names the red assertion and never the dormant guards', () => {
    const fx = makeFixture(REPORT_OWN_RED_WITH_DORMANT);
    const artifact = ground(fx, 'ISSUE-A');
    expect(artifact.unitTestsPass).toBe(false);
    const failures = artifact.notes.find((n) => n.startsWith('vitest failures:'));
    expect(failures).toBeDefined();
    expect(failures).toContain('ISSUE-A/AC-1');
    expect(failures).not.toContain('ISSUE-B');
    // dormancy still surfaces — in ITS listing, not in the failure note
    expect(artifact.notes.some((n) => /not activated/i.test(n) && n.includes('ISSUE-B'))).toBe(true);
  });

  it('ISSUE-0022/AC-SCOPED-001 gate pin: a report without an overall success field treats dormancy as non-failure', () => {
    const fx = makeFixture(REPORT_NO_SUCCESS_FIELD);
    const artifact = ground(fx, 'ISSUE-A');
    expect(artifact.unitTestsPass).toBe(true);
    expect(artifact.satisfied['AC-1']).toBe(true);
  });

  it("ISSUE-0022/AC-SCOPED-001 gate pin: the driven issue's own all-dormant guard fails LOUD — unsatisfied plus an activation-gap note", () => {
    const fx = makeFixture(REPORT_OWN_DORMANT);
    const artifact = ground(fx, 'ISSUE-A');
    expect(artifact.satisfied['AC-1']).toBe(false);
    expect(artifact.notes.some((n) => /activation gap/i.test(n) && n.includes('AC-1'))).toBe(true);
  });

  it('ISSUE-0022/AC-SCOPED-003 gate pin: every never-ran reporter status counts as dormant (skipped/pending/todo/disabled)', () => {
    const assertions = ['skipped', 'pending', 'todo', 'disabled'].map((status, i) => ({
      name: `ISSUE-B/AC-${i + 1} dormant via ${status}`,
      passed: false,
      skipped: true,
    }));
    // parseVitest classification is exercised end-to-end by the fixtures above (each
    // report uses a different status); this pins the aggregation over all four at once.
    const notes = dormantGuardNotes(assertions, 'ISSUE-A');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('ISSUE-B');
    expect(notes[0]).toContain('4 skipped assertions');
  });

  it("ISSUE-0022/AC-SCOPED-004 gate pin: a command's own scoped prefix outranks the injected driven issue (captured spelling wins)", () => {
    // keep the ambient-neutralizing ACCEPT_HARNESS= — this pin runs under full-activation
    // regress commands too, and an inherited flag would mask the precedence being pinned
    // (the flip-side is pinned by the explicit-full-activation test below).
    const fx = makeFixture(REPORT_ALL_ACTIVE, `ACCEPT_HARNESS= ${SCOPED_ACCEPT_ENV}=ISSUE-P `);
    ground(fx, 'ISSUE-Q');
    const childEnv = fx.readEnv();
    expect(acceptsIssue('ISSUE-P', childEnv)).toBe(true);
    expect(acceptsIssue('ISSUE-Q', childEnv)).toBe(false);
  });

  it('ISSUE-0022/AC-SCOPED-004 gate pin: an explicit full-activation prefix outranks scoped injection (everything stays collectable)', () => {
    const fx = makeFixture(REPORT_ALL_ACTIVE, 'ACCEPT_HARNESS=1 ');
    ground(fx, 'ISSUE-Q');
    const childEnv = fx.readEnv();
    expect(acceptsIssue('ISSUE-B', childEnv)).toBe(true);
    expect(acceptsIssue('ISSUE-Q', childEnv)).toBe(true);
  });

  it('ISSUE-0022/AC-SCOPED-001 gate pin: the regression executor keeps a dormant matched assertion LOUD (fail, never a silent pass)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-scoped-regress-'));
    const store = new Store(root);
    store.addEvalTask(
      EvalTask.parse({
        id: 'EVAL-TASK-ISSUE-X-AC-1',
        sourceIssueId: 'ISSUE-X',
        featureArea: 'harness',
        userGoal: 'g',
        graders: ['unit_test'],
        severity: 'blocker',
        createdAt: nowISO(),
        target: '.',
      }),
    );
    const config: HarnessConfig = {
      ...DEFAULT_CONFIG,
      generator: 'claude',
      target: { repo: '.', graders: { unit_tests: 'vitest run' } },
    };
    const { results } = runRegressionTasks(store, config, {
      report: () => ({
        success: true,
        total: 1,
        passed: 0,
        failedNames: [],
        assertions: [{ name: 'ISSUE-X/AC-1 holding guard left dormant', passed: false, skipped: true }],
      }),
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.result).toBe('fail');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
