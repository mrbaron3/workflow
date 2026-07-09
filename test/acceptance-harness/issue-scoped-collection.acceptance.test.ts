/**
 * Env-gated acceptance grader for ISSUE-0022 — spec
 * docs/specs/issue-scoped-acceptance-collection (AC-SCOPED-001..004, FEAT-009 / EPIC-04,
 * the D3 omnibus-gate closure: suite-wide collection forced the first driven issue to
 * implement OTHER issues' pre-placed payloads — ISSUE-0019 carried 0020/0021).
 *
 * Red at baseline BY DESIGN, collected only under ACCEPT_HARNESS=1 (ADR-0007 I3).
 * Exceptions that are correctly GREEN pre-implementation (invariance pins, the
 * AC-REGMT-004 precedent): "own red still fails the gate" and "no dormant guards →
 * no listing" hold today and must keep holding.
 *
 * The unresolved seam (src/pipeline/execution/accept.ts) is referenced via a
 * computed-specifier lazy dynamic import inside each test (⑨ rule: a literal import —
 * even dynamic — breaks baseline tsc; a top-level await breaks the suite before skipIf).
 *
 * Seams this file pins (harness-owned WHAT confirmation):
 *   - acceptsIssue(issueId, env?) / scopedAcceptEnv(issueId) live in ONE module (the
 *     single home for the activation semantics and env spelling — the eval-task.ts
 *     precedent). Full activation stays ACCEPT_HARNESS truthy-nonempty ('' is OFF);
 *     scoped activation admits only the declared issue. The predicate is callable per
 *     declaration, so guards of two issues sharing one FILE resolve independently
 *     (describe-level granularity — the 0019/0020 shared-file convention survives).
 *   - groundArtifact injects the driven issue's scoped activation (opts.issueId) into
 *     the grader child env; without issueId nothing is injected (additive backward
 *     compat), and an explicit full-activation command prefix keeps meaning "all"
 *     (captured regress commands unchanged).
 *   - pre-placed guards left dormant surface in the grounded artifact's notes with the
 *     owning issue and the reason (never-silent, ARCH-execution-015) — derived from the
 *     report facts (skipped scoped assertions), never used to DECIDE activation.
 *
 * The fake grader below writes a crafted vitest JSON report to the --outputFile path
 * runVitest appends, and dumps its own env — so every collection branch is decided
 * deterministically, with no nested real vitest run. The `ACCEPT_HARNESS=` (empty)
 * command prefix neutralizes the flag THIS acceptance run itself exports; a dedicated
 * test asserts empty-is-off explicitly.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { groundArtifact } from '../../src/pipeline/execution/grade.js';
import type { IssueContract } from '../../src/domain/schema.js';

const ACCEPT = !!process.env.ACCEPT_HARNESS;

type AcceptSeam = {
  acceptsIssue: (issueId: string, env?: Record<string, string | undefined>) => boolean;
  scopedAcceptEnv: (issueId: string) => Record<string, string>;
};
const acceptSeam = (): Promise<AcceptSeam> => import('../../src/pipeline/execution/' + 'accept.js');

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
        { fullName: 'ISSUE-B/AC-2 other pre-placed guard left dormant too', status: 'skipped' },
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

/**
 * A grader command that dumps its child env and emits the crafted report to the
 * --outputFile runVitest appends. `envPrefix` defaults to neutralizing the outer
 * ACCEPT_HARNESS so scoped-only activation is decidable inside this gated run.
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

describe.skipIf(!ACCEPT)('issue-scoped acceptance collection (ISSUE-0022)', () => {
  it('ISSUE-0022/AC-SCOPED-001 single-home predicate: scoped activation admits only the declared issue, full activation admits all, empty flag is off', async () => {
    const { acceptsIssue, scopedAcceptEnv } = await acceptSeam();
    const env = scopedAcceptEnv('ISSUE-A');
    expect(acceptsIssue('ISSUE-A', env)).toBe(true);
    expect(acceptsIssue('ISSUE-B', env)).toBe(false);
    expect(acceptsIssue('ISSUE-B', { ACCEPT_HARNESS: '1' })).toBe(true);
    expect(acceptsIssue('ISSUE-A', {})).toBe(false);
    expect(acceptsIssue('ISSUE-A', { ACCEPT_HARNESS: '' })).toBe(false);
  });

  it("ISSUE-0022/AC-SCOPED-001 grading a driven issue injects its scoped activation into the grader child env and passes on the issue's own green delta", async () => {
    const { acceptsIssue } = await acceptSeam();
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

  it('ISSUE-0022/AC-SCOPED-002 activation resolves per declared guard, not per file: two declarations sharing one file get independent answers', async () => {
    const { acceptsIssue, scopedAcceptEnv } = await acceptSeam();
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

  it('ISSUE-0022/AC-SCOPED-004 an explicit full-activation command prefix keeps activating every declared guard (captured regress commands unchanged)', async () => {
    const { acceptsIssue } = await acceptSeam();
    const fx = makeFixture(REPORT_ALL_ACTIVE, 'ACCEPT_HARNESS=1 ');
    const artifact = ground(fx); // no driven issue — e.g. a regress-captured command
    const childEnv = fx.readEnv();
    expect(acceptsIssue('ISSUE-A', childEnv)).toBe(true);
    expect(acceptsIssue('ISSUE-B', childEnv)).toBe(true);
    expect(artifact.unitTestsPass).toBe(true);
  });

  it('ISSUE-0022/AC-SCOPED-004 grading without a driven issue injects no scoped activation (additive backward compat)', async () => {
    const { acceptsIssue } = await acceptSeam();
    const fx = makeFixture(REPORT_ALL_ACTIVE);
    const artifact = ground(fx); // no issueId, no full-activation prefix
    const childEnv = fx.readEnv();
    expect(acceptsIssue('ISSUE-A', childEnv)).toBe(false);
    expect(artifact.unitTestsPass).toBe(true);
  });
});
