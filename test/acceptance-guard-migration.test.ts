/**
 * MIGRATION PIN (ISSUE-0022 repair): the harness-owned pre-placed guard file
 * `test/acceptance-harness/issue-scoped-collection.acceptance.test.ts` predates the
 * scoped-activation convention. It gates on the legacy full-activation spelling
 * (`const ACCEPT = !!process.env.ACCEPT_HARNESS`), not on
 * `describe.skipIf(!acceptsIssue('ISSUE-0022'))` — so under ISSUE-0022's OWN scoped
 * grading (ACCEPT_HARNESS_ISSUE=ISSUE-0022) every guard in it is dormant. That
 * inconsistency is measured below with a real nested vitest run, so it is an explicit,
 * pinned migration step — never a silent assumption.
 *
 * The guard file is harness-owned (config protectedPaths / scope.exclude): a build
 * cannot edit it, so the pin — not a fix-in-place — is the honest artifact.
 *
 * Migration procedure (owner: the harness / issue driver, outside any build's scope):
 *   1. Until the guard file migrates, ISSUE-0022's own acceptance verdict comes from
 *      full activation (`ACCEPT_HARNESS=1 vitest run`) — the captured baseline-RED
 *      spelling, whose meaning AC-SCOPED-004 keeps frozen.
 *   2. NEW pre-placed guard files declare per-issue activation from day one:
 *      `describe.skipIf(!acceptsIssue('ISSUE-XXXX'))` (accept.ts documents the shape;
 *      scoped-collection-integration.test.ts proves it against real collection).
 *   3. When the harness migrates the guard file to the declaration convention (or
 *      promotes its guards by dropping the gate), BOTH pins below fail loudly —
 *      delete this whole file as part of that migration.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runVitest } from '../src/pipeline/execution/grade.js';
import { scopedAcceptEnv, FULL_ACCEPT_ENV } from '../src/pipeline/execution/accept.js';

/** Nested runs spawn a whole vitest process — give them headroom over the 5s default. */
const NESTED_VITEST_TIMEOUT_MS = 120_000;

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const GUARD_FILE = 'test/acceptance-harness/issue-scoped-collection.acceptance.test.ts';

const req = createRequire(import.meta.url);
const vitestPkgPath = req.resolve('vitest/package.json');
const vitestPkg = req(vitestPkgPath) as { bin: { vitest: string } };
const VITEST_ENTRY = path.join(path.dirname(vitestPkgPath), vitestPkg.bin.vitest);

describe('acceptance-guard migration pin (harness-owned file still on the legacy gate)', () => {
  it('source pin: the guard file still gates on the legacy full-activation spelling, not per-issue declaration', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, GUARD_FILE), 'utf8');
    // the unmigrated markers — when these flip, the migration happened: delete this file
    expect(source).toContain('const ACCEPT = !!process.env.ACCEPT_HARNESS');
    expect(source).toContain('describe.skipIf(!ACCEPT)');
    expect(source).not.toMatch(/skipIf\(!\s*acceptsIssue/);
  });

  it(
    "measured pin: under its own scoped grading the driven issue's pre-placed guards are ALL dormant (the legacy gate never consults the scoped env)",
    () => {
      const report = runVitest(
        `${FULL_ACCEPT_ENV}= node ${VITEST_ENTRY} run ${GUARD_FILE}`,
        REPO_ROOT,
        scopedAcceptEnv('ISSUE-0022'),
      );
      expect(report.total).toBeGreaterThan(0);
      // every guard skipped, none executed: scoped grading cannot activate this file yet
      expect(report.assertions.every((a) => a.skipped)).toBe(true);
      expect(report.success).toBe(true);
    },
    NESTED_VITEST_TIMEOUT_MS,
  );
});
