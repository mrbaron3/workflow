/**
 * PERMANENT regression guard for the self-hosted improvement issue ISSUE-0003
 * "scope_check must honor scope.exclude" (ADR-0007 帰結; the ② finding: grade.ts once
 * consulted scope.include + protectedPaths only, so scope.exclude was decorative).
 *
 * This began as the env-gated *acceptance grader* for the ③ drive — red at baseline BY
 * DESIGN, collected only under ACCEPT_HARNESS=1 (ADR-0007 I3), so the drive's real Claude
 * session had to make it pass but could not edit it (config.target.protectedPaths). The fix
 * was human-approved and released (2026-07-07), so per the steering star ("never repeat the
 * same failure twice") the skipIf is dropped: it now runs in the ordinary suite. It stays in
 * test/acceptance-harness/ (protectedPaths) so a FUTURE self-hosted drive cannot silence it —
 * the durable, tamper-proof guard, complementing the agent's own unprotected test/grade-scope.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { groundArtifact } from '../../src/pipeline/execution/grade.js';
import type { IssueContract } from '../../src/domain/schema.js';

const contract: IssueContract = {
  productGoal: 'g',
  userStory: 'u',
  scope: { include: ['src/**'], exclude: ['src/generated/**'] },
  acceptanceCriteria: [
    { id: 'AC-1', severity: 'blocker', behavior: 'excluded is violation', verification: { method: 'unit_test', expected: ['x'] } },
  ],
  redLines: [],
};

/** Ground with no graders configured — pure scope_check, no commands run. */
function violations(changed: string[]): string[] {
  return groundArtifact({
    contract,
    target: { repo: '.' },
    worktree: process.cwd(),
    branch: 'acceptance',
    changed,
  }).scopeViolations;
}

describe('scope_check honors scope.exclude', () => {
  it('AC-1 a changed file matching scope.exclude is a violation even when scope.include matches it', () => {
    expect(violations(['src/generated/out.ts'])).toContain('src/generated/out.ts');
  });

  it('AC-2 in-scope files not matching scope.exclude stay clean (no regression)', () => {
    expect(violations(['src/feature.ts'])).toEqual([]);
  });
});
