/**
 * Issue-scoped collection measured END-TO-END (ISSUE-0022, AC-SCOPED-001/002/003/004):
 * the env → acceptsIssue → describe.skipIf → REAL vitest collection → JSON report → gate
 * chain itself, not simulations of its two ends. The in-process predicate tests
 * (accept.test.ts) and the crafted-report grading tests (grade-scoped.test.ts) each pin
 * one end; this file spawns a real nested vitest run so "the other issue's guards are
 * not executed" is a measured result, never a fixture assumption.
 *
 * The generated fixture guard file follows the declaration convention accept.ts
 * documents — `describe.skipIf(!acceptsIssue('ISSUE-XXXX'))` — with declarations for TWO
 * issues sharing ONE file (the 0019/0020 shared-file convention, AC-SCOPED-002) plus a
 * promoted (no skipIf) guard. The foreign issue's guard body is baseline-RED on purpose:
 * if scoping ever failed to keep it dormant (or activation were file-level
 * all-or-nothing), the nested run itself would FAIL — non-execution is proven by the
 * run verdict, not just by the reported status.
 *
 * Every nested run goes through the same capture path the harness grades with
 * (runVitest / groundArtifact append --reporter=json --outputFile and parse it back).
 * Explicit env prefixes neutralize whatever activation the OUTER run exports, so the
 * file is deterministic under plain, full-activation and scoped outer suites alike.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { groundArtifact, runVitest, type VitestReport } from '../src/pipeline/execution/grade.js';
import { scopedAcceptEnv, FULL_ACCEPT_ENV, SCOPED_ACCEPT_ENV } from '../src/pipeline/execution/accept.js';
import type { BuildArtifact } from '../src/domain/artifact.js';
import type { IssueContract } from '../src/domain/schema.js';

/** Nested runs spawn a whole vitest process — give hooks headroom over the 5s default. */
const NESTED_VITEST_TIMEOUT_MS = 120_000;

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
/** The single-home module the fixture guard file imports — the REAL predicate, by absolute path. */
const ACCEPT_MODULE = path.join(REPO_ROOT, 'src', 'pipeline', 'execution', 'accept.ts');

// The real vitest binary, resolved through this repo's own dependency graph (the
// worktree may hoist node_modules to a parent — never assume ./node_modules/.bin).
const req = createRequire(import.meta.url);
const vitestPkgPath = req.resolve('vitest/package.json');
const vitestPkg = req(vitestPkgPath) as { bin: { vitest: string } };
const VITEST_ENTRY = path.join(path.dirname(vitestPkgPath), vitestPkg.bin.vitest);
/** node_modules the fixture links so its bare `import ... from 'vitest'` resolves. */
const NODE_MODULES_DIR = path.dirname(path.dirname(vitestPkgPath));

const NESTED_VITEST = `node ${VITEST_ENTRY} run`;
/** Empty is OFF (accept.ts): blanks a full-activation flag an env-gated OUTER run exports. */
const NEUTRAL_PREFIX = `${FULL_ACCEPT_ENV}= `;

/**
 * A pre-placed guard file written the way accept.ts tells guard authors to write one.
 * ISSUE-X: the driven issue, green payload. ISSUE-Y: another in-flight issue in the SAME
 * file, baseline-RED payload (fails if it ever runs). Released guard: skipIf dropped at
 * promotion — never consults the predicate.
 */
const GUARD_FILE_SOURCE = [
  "import { describe, it, expect } from 'vitest';",
  `import { acceptsIssue } from '${ACCEPT_MODULE}';`,
  '',
  "describe.skipIf(!acceptsIssue('ISSUE-X'))('ISSUE-X pre-placed guards', () => {",
  "  it('ISSUE-X/AC-1 own pre-placed guard is green', () => {",
  '    expect(1 + 1).toBe(2);',
  '  });',
  '});',
  '',
  '// baseline-RED: executing this under a run scoped to ISSUE-X fails the whole run',
  "describe.skipIf(!acceptsIssue('ISSUE-Y'))('ISSUE-Y pre-placed guards', () => {",
  "  it('ISSUE-Y/AC-1 foreign baseline-red pre-placed guard', () => {",
  "    expect('implemented').toBe('not yet');",
  '  });',
  '});',
  '',
  "describe('released guards', () => {",
  "  it('released regression guard runs unconditionally', () => {",
  '    expect(true).toBe(true);',
  '  });',
  '});',
  '',
].join('\n');

const contract: IssueContract = {
  productGoal: 'g',
  userStory: 'u',
  scope: { include: [], exclude: [] },
  acceptanceCriteria: [
    { id: 'AC-1', severity: 'blocker', behavior: 'b', verification: { method: 'unit_test', expected: ['x'] } },
  ],
  redLines: [],
};

const byTag = (report: VitestReport, tag: string) => report.assertions.find((a) => a.name.includes(tag));

describe('issue-scoped collection through a real nested vitest run', () => {
  let fixtureDir: string;
  let scopedReport: VitestReport;
  let fullReport: VitestReport;
  let scopedArtifact: BuildArtifact;

  beforeAll(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-scoped-collection-'));
    fs.symlinkSync(NODE_MODULES_DIR, path.join(fixtureDir, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(fixtureDir, 'guards.test.mjs'), GUARD_FILE_SOURCE);

    // scoped run: what the grader child sees when ISSUE-X is the driven issue
    scopedReport = runVitest(`${NEUTRAL_PREFIX}${NESTED_VITEST}`, fixtureDir, scopedAcceptEnv('ISSUE-X'));
    // full activation: the captured baseline-RED / whole-registry spelling
    fullReport = runVitest(`${FULL_ACCEPT_ENV}=1 ${SCOPED_ACCEPT_ENV}= ${NESTED_VITEST}`, fixtureDir);
    // the whole grading path: groundArtifact injects the scoped env itself
    scopedArtifact = groundArtifact({
      contract,
      target: { repo: '.', graders: { unit_tests: `${NEUTRAL_PREFIX}${NESTED_VITEST}` } },
      worktree: fixtureDir,
      branch: 'test',
      changed: [],
      issueId: 'ISSUE-X',
    });
  }, NESTED_VITEST_TIMEOUT_MS);

  afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("ISSUE-0022/AC-SCOPED-001 the driven issue's declared guard is collected and RUNS green under its scoped env", () => {
    expect(scopedReport.total).toBeGreaterThan(0);
    const own = byTag(scopedReport, 'ISSUE-X/AC-1');
    expect(own?.passed).toBe(true);
    expect(own?.skipped).toBeFalsy();
  });

  it("ISSUE-0022/AC-SCOPED-001 the foreign issue's pre-placed guard reports status skipped and its baseline-RED never executes", () => {
    const foreign = byTag(scopedReport, 'ISSUE-Y/AC-1');
    expect(foreign?.skipped).toBe(true);
    expect(foreign?.passed).toBe(false);
    // the RED body never ran: had it executed, the nested run itself would have failed
    expect(scopedReport.success).toBe(true);
  });

  it('ISSUE-0022/AC-SCOPED-002 two declarations sharing ONE file diverge under real collection: per-declaration, never per-file', () => {
    // both assertions come from the single guards.test.mjs the fixture wrote
    const own = byTag(scopedReport, 'ISSUE-X/AC-1');
    const foreign = byTag(scopedReport, 'ISSUE-Y/AC-1');
    expect(own?.skipped).toBeFalsy();
    expect(foreign?.skipped).toBe(true);
  });

  it('ISSUE-0022/AC-SCOPED-004 a promoted (no skipIf) guard still runs under scoped grading', () => {
    const released = byTag(scopedReport, 'released regression guard');
    expect(released?.passed).toBe(true);
    expect(released?.skipped).toBeFalsy();
  });

  it('ISSUE-0022/AC-SCOPED-004 full activation keeps collecting every declared guard: the foreign baseline-RED runs and fails', () => {
    const own = byTag(fullReport, 'ISSUE-X/AC-1');
    const foreign = byTag(fullReport, 'ISSUE-Y/AC-1');
    const released = byTag(fullReport, 'released regression guard');
    expect(own?.passed).toBe(true);
    expect(released?.passed).toBe(true);
    // ran (not skipped) and failed — exactly what a baseline-RED check must observe
    expect(foreign?.skipped).toBeFalsy();
    expect(foreign?.passed).toBe(false);
    expect(fullReport.success).toBe(false);
    expect(fullReport.failedNames.some((n) => n.includes('ISSUE-Y/AC-1'))).toBe(true);
  });

  it("ISSUE-0022/AC-SCOPED-001 grading the driven issue passes the hard gate on its own green delta, measured through real collection", () => {
    expect(scopedArtifact.unitTestsPass).toBe(true);
    expect(scopedArtifact.satisfied['AC-1']).toBe(true);
    expect(scopedArtifact.notes.some((n) => n.startsWith('vitest failures'))).toBe(false);
  });

  it('ISSUE-0022/AC-SCOPED-003 the dormant foreign guard is listed with owner and reason, derived from the real report facts', () => {
    const listing = scopedArtifact.notes.filter((n) => /not activated/i.test(n));
    expect(listing.length).toBeGreaterThan(0);
    expect(listing.some((n) => n.includes('ISSUE-Y') && /driv/i.test(n))).toBe(true);
    // the driven issue's own (running) guards are never attributed as dormant
    expect(listing.some((n) => n.includes('ISSUE-X ('))).toBe(false);
  });
});
