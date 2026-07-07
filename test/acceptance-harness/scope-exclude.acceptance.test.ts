/**
 * HARNESS-OWNED acceptance suite for the self-hosted improvement issue
 * "scope_check must honor scope.exclude" (ADR-0007 帰結; the ② finding recorded in the
 * handoff: grade.ts consults scope.include + protectedPaths only, so scope.exclude is
 * decorative).
 *
 * env-gate convention (ADR-0007 I3): collected ONLY when ACCEPT_HARNESS=1 — red at baseline
 * BY DESIGN, so the ordinary `npm test` must not see it. The execution layer's grader runs
 * with the env set (scripts/real-run-self.ts), making this the independent grader the agent
 * must satisfy but may not edit (config.target.protectedPaths). Once the fix is released,
 * drop the skipIf to promote it into the permanent regression suite.
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

describe.skipIf(!process.env.ACCEPT_HARNESS)('scope_check honors scope.exclude', () => {
  it('AC-1 a changed file matching scope.exclude is a violation even when scope.include matches it', () => {
    expect(violations(['src/generated/out.ts'])).toContain('src/generated/out.ts');
  });

  it('AC-2 in-scope files not matching scope.exclude stay clean (no regression)', () => {
    expect(violations(['src/feature.ts'])).toEqual([]);
  });
});
