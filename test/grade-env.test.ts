/**
 * Grader commands support sh-style leading KEY=VAL env assignments (ADR-0007 I3).
 * `run` in grade.ts uses spawnSync WITHOUT a shell, so `ACCEPT_HARNESS=1 vitest run`
 * would otherwise try to exec a binary literally named "ACCEPT_HARNESS=1". The env-gate
 * convention for self-hosted acceptance suites depends on this peeling.
 */
import { describe, it, expect } from 'vitest';
import { groundArtifact } from '../src/pipeline/execution/grade.js';
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

/** Ground with only a typecheck grader — its exit code is the whole signal. */
function typecheckWith(command: string): boolean {
  const a = groundArtifact({
    contract,
    target: { repo: '.', graders: { typecheck: command } },
    worktree: process.cwd(),
    branch: 'test',
    changed: [],
  });
  return a.typecheckPasses;
}

describe('grader command env prefixes (KEY=VAL …)', () => {
  it('a leading KEY=VAL lands in the child process env', () => {
    expect(typecheckWith(`AGENTOPS_GATE=on node -e process.exit(process.env.AGENTOPS_GATE==='on'?0:1)`)).toBe(true);
  });

  it('multiple leading assignments all apply', () => {
    expect(typecheckWith(`A=1 B=2 node -e process.exit(process.env.A==='1'&&process.env.B==='2'?0:1)`)).toBe(true);
  });

  it('without the prefix the variable is absent (no leakage between runs)', () => {
    expect(typecheckWith(`node -e process.exit(process.env.AGENTOPS_GATE===undefined?0:1)`)).toBe(true);
  });
});
