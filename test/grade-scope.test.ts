/**
 * scope_check judges changed files against the WHOLE contract scope (ISSUE-0003):
 * scope.exclude carves exceptions out of broad include globs, so a changed file matching
 * exclude is a scope violation even when include also matches it. Exclude enforcement is
 * ADDITIVE to protectedPaths — neither weakens the other.
 */
import { describe, it, expect } from 'vitest';
import { groundArtifact } from '../src/pipeline/execution/grade.js';
import type { IssueContract } from '../src/domain/schema.js';
import type { TargetRepoConfig } from '../src/config.js';

function contractWith(scope: IssueContract['scope']): IssueContract {
  return {
    productGoal: 'g',
    userStory: 'u',
    scope,
    acceptanceCriteria: [
      { id: 'AC-1', severity: 'blocker', behavior: 'b', verification: { method: 'unit_test', expected: ['x'] } },
    ],
    redLines: [],
  };
}

/** Ground with no graders configured — pure scope_check, no commands run. */
function violations(scope: IssueContract['scope'], changed: string[], target: TargetRepoConfig = { repo: '.' }): string[] {
  return groundArtifact({
    contract: contractWith(scope),
    target,
    worktree: process.cwd(),
    branch: 'test',
    changed,
  }).scopeViolations;
}

describe('scope_check honors scope.exclude', () => {
  it('AC-1 a changed file matching scope.exclude is a violation even when scope.include matches it', () => {
    expect(violations({ include: ['src/**'], exclude: ['src/generated/**'] }, ['src/generated/out.ts'])).toContain(
      'src/generated/out.ts',
    );
  });

  it('AC-1 exclude flags the excluded file only, not its in-scope siblings', () => {
    expect(
      violations({ include: ['test/**'], exclude: ['test/acceptance-harness/**'] }, [
        'test/acceptance-harness/x.test.ts',
        'test/other.test.ts',
      ]),
    ).toEqual(['test/acceptance-harness/x.test.ts']);
  });

  it('AC-2 in-scope files not matching scope.exclude produce no scopeViolations', () => {
    expect(violations({ include: ['src/**'], exclude: ['src/generated/**'] }, ['src/feature.ts'])).toEqual([]);
  });

  it('AC-2 empty exclude keeps prior behavior (include-only check)', () => {
    expect(violations({ include: ['src/**'], exclude: [] }, ['src/feature.ts', 'docs/readme.md'])).toEqual([
      'docs/readme.md',
    ]);
  });

  it('protectedPaths stay enforced alongside exclude (additive, no double-count)', () => {
    const target: TargetRepoConfig = { repo: '.', protectedPaths: ['.github/'] };
    expect(
      violations({ include: ['src/**', '.github/**'], exclude: ['src/generated/**'] }, [
        '.github/workflows/ci.yml',
        'src/generated/out.ts',
        'src/feature.ts',
      ], target),
    ).toEqual(['.github/workflows/ci.yml', 'src/generated/out.ts']);
  });
});
