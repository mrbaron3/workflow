/**
 * Issue-scoped grading (ISSUE-0022, AC-SCOPED-001/003/004): groundArtifact injects the
 * driven issue's scoped activation (accept.ts) into the unit_tests grader child env, so
 * each build is gated on ITS OWN pre-placed guards plus the ordinary suite — other
 * in-flight issues' baseline-red guards stay dormant and never fail the hard gate.
 * Dormant guards are never a silent skip (ARCH-execution-015): they surface in the
 * grounded artifact's notes with the owning issue and the reason, derived from the
 * report facts (skipped scoped assertions) — never used to DECIDE activation.
 *
 * The fake grader below dumps its own env and writes a crafted vitest JSON report to the
 * --outputFile path runVitest appends, so every branch is decided deterministically with
 * no nested real vitest run (the grade-env.test.ts spawn pattern). The `ACCEPT_HARNESS=`
 * (empty) prefix neutralizes the flag an env-gated outer run exports.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { groundArtifact, dormantGuardNotes } from '../src/pipeline/execution/grade.js';
import { acceptsIssue, FULL_ACCEPT_ENV, SCOPED_ACCEPT_ENV } from '../src/pipeline/execution/accept.js';
import type { IssueContract } from '../src/domain/schema.js';

const contract: IssueContract = {
  productGoal: 'g',
  userStory: 'u',
  scope: { include: [], exclude: [] },
  acceptanceCriteria: [
    { id: 'AC-1', severity: 'blocker', behavior: 'b', verification: { method: 'unit_test', expected: ['x'] } },
  ],
  redLines: [],
};

/** Own guard green, baseline green, another issue's pre-placed guards dormant. */
const REPORT_DORMANT = {
  success: true,
  testResults: [
    {
      assertionResults: [
        { fullName: 'ISSUE-A/AC-1 own pre-placed guard is green', status: 'passed' },
        { fullName: 'baseline suite stays green', status: 'passed' },
        { fullName: 'ISSUE-B/AC-1 other pre-placed guard left dormant', status: 'skipped' },
        { fullName: 'ISSUE-B/AC-2 other pre-placed guard left dormant too', status: 'skipped' },
      ],
    },
  ],
};

/** The driven issue's OWN guard is red — the gate must stay strict. */
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

/** Nothing dormant — the listing must stay silent. */
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

/**
 * A grader command that dumps its child env and emits the crafted report to the
 * --outputFile runVitest appends. `envPrefix` defaults to neutralizing the outer
 * ACCEPT_HARNESS so scoped-only activation is decidable under an env-gated run too.
 */
function makeFixture(report: unknown, envPrefix = `${FULL_ACCEPT_ENV}= `) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-grade-scoped-'));
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
    branch: 'test',
    changed: [],
    ...(issueId ? { issueId } : {}),
  });
}

describe('issue-scoped grading (groundArtifact × accept.ts)', () => {
  it('ISSUE-0022/AC-SCOPED-001 grading with a driven issue injects its scoped activation into the grader child env', () => {
    const fx = makeFixture(REPORT_DORMANT);
    ground(fx, 'ISSUE-A');
    const childEnv = fx.readEnv();
    expect(acceptsIssue('ISSUE-A', childEnv)).toBe(true);
    expect(acceptsIssue('ISSUE-B', childEnv)).toBe(false);
  });

  it("ISSUE-0022/AC-SCOPED-001 the hard gate passes on the driven issue's own green delta while other issues' guards stay dormant", () => {
    const fx = makeFixture(REPORT_DORMANT);
    const artifact = ground(fx, 'ISSUE-A');
    expect(artifact.unitTestsPass).toBe(true);
    expect(artifact.satisfied['AC-1']).toBe(true);
    // the other issue's dormant RED never shows up as a failure of this build
    expect(artifact.notes.some((n) => n.startsWith('vitest failures'))).toBe(false);
  });

  it("ISSUE-0022/AC-SCOPED-001 the driven issue's own red still fails the gate (scoping never exempts the driven issue)", () => {
    const fx = makeFixture(REPORT_OWN_RED);
    const artifact = ground(fx, 'ISSUE-A');
    expect(artifact.unitTestsPass).toBe(false);
    expect(artifact.satisfied['AC-1']).toBe(false);
  });

  it('ISSUE-0022/AC-SCOPED-003 dormant pre-placed guards are listed with the owning issue and the reason (never a silent skip)', () => {
    const fx = makeFixture(REPORT_DORMANT);
    const artifact = ground(fx, 'ISSUE-A');
    const listing = artifact.notes.filter((n) => /not activated/i.test(n));
    expect(listing.length).toBeGreaterThan(0);
    expect(listing.some((n) => n.includes('ISSUE-B') && /driv/i.test(n))).toBe(true);
  });

  it('ISSUE-0022/AC-SCOPED-003 no dormant guards → no non-activation listing', () => {
    const fx = makeFixture(REPORT_ALL_ACTIVE);
    const artifact = ground(fx, 'ISSUE-A');
    expect(artifact.notes.some((n) => /not activated/i.test(n))).toBe(false);
  });

  it('ISSUE-0022/AC-SCOPED-003 the listing derives from report facts: only skipped assertions scoped to ANOTHER issue count', () => {
    const assertions = [
      { name: 'ISSUE-A/AC-1 own green', passed: true, skipped: false },
      { name: 'ISSUE-A/AC-2 own skipped (not a foreign dormant guard)', passed: false, skipped: true },
      { name: 'plain skipped suite test (unattributed, not listed here)', passed: false, skipped: true },
      { name: 'ISSUE-B/AC-1 foreign dormant', passed: false, skipped: true },
      { name: 'ISSUE-B/AC-2 foreign dormant too', passed: false, skipped: true },
      { name: 'ISSUE-C/AC-1 foreign but RUNNING and green', passed: true, skipped: false },
    ];
    const notes = dormantGuardNotes(assertions, 'ISSUE-A');
    expect(notes).toHaveLength(1); // one line per owning issue: ISSUE-B only
    expect(notes[0]).toContain('ISSUE-B');
    expect(notes[0]).toMatch(/not activated/i);
    expect(notes[0]).toMatch(/driv/i); // the reason names the driven-issue scoping
    expect(notes[0]).not.toContain('ISSUE-C');
  });

  it('ISSUE-0022/AC-SCOPED-004 an explicit full-activation command prefix keeps admitting every declared guard (captured regress commands unchanged)', () => {
    const fx = makeFixture(REPORT_ALL_ACTIVE, `${FULL_ACCEPT_ENV}=1 `);
    const artifact = ground(fx); // no driven issue — e.g. a regress-captured command
    const childEnv = fx.readEnv();
    expect(acceptsIssue('ISSUE-A', childEnv)).toBe(true);
    expect(acceptsIssue('ISSUE-B', childEnv)).toBe(true);
    expect(artifact.unitTestsPass).toBe(true);
  });

  it('ISSUE-0022/AC-SCOPED-004 a full-activation prefix is not narrowed by a driven issue (the spelling keeps its meaning)', () => {
    const fx = makeFixture(REPORT_ALL_ACTIVE, `${FULL_ACCEPT_ENV}=1 `);
    ground(fx, 'ISSUE-A');
    const childEnv = fx.readEnv();
    expect(acceptsIssue('ISSUE-B', childEnv)).toBe(true);
  });

  it('ISSUE-0022/AC-SCOPED-004 grading without a driven issue injects no scoped activation (additive backward compat)', () => {
    // the prefix also blanks the scoped var, so an env-gated/scoped OUTER run cannot leak in
    const fx = makeFixture(REPORT_ALL_ACTIVE, `${FULL_ACCEPT_ENV}= ${SCOPED_ACCEPT_ENV}= `);
    const artifact = ground(fx); // no issueId, no full-activation prefix
    const childEnv = fx.readEnv();
    expect(acceptsIssue('ISSUE-A', childEnv)).toBe(false);
    expect(artifact.unitTestsPass).toBe(true);
    expect(artifact.notes.some((n) => /not activated/i.test(n))).toBe(false);
  });
});
