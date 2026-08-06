import { describe, it, expect } from 'vitest';
import { gradeBuild } from '../src/graders/index.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { IssueContract } from '../src/domain/schema.js';
import type { BuildArtifact } from '../src/domain/artifact.js';
import { HARD_GATE_SIGNAL_NAMES } from '../src/graders/gate-names.js';

const contract: IssueContract = {
  productGoal: 'g',
  userStory: 'u',
  scope: { include: [], exclude: [] },
  acceptanceCriteria: [
    { id: 'AC-001', severity: 'blocker', behavior: 'persists', verification: { method: 'playwright', expected: ['stays after reload'] } },
    { id: 'AC-002', severity: 'minor', behavior: 'empty state', verification: { method: 'playwright', expected: ['shows empty'] } },
  ],
  redLines: [],
};

function artifact(over: Partial<BuildArtifact> = {}): BuildArtifact {
  return {
    branch: 'b',
    summary: '',
    filesChanged: [],
    satisfied: { 'AC-001': true, 'AC-002': true },
    buildPasses: true,
    typecheckPasses: true,
    unitTestsPass: true,
    apiTestsPass: true,
    hasTests: true,
    secretsLeaked: false,
    scopeViolations: [],
    quality: { codeQuality: 0.9, testQuality: 0.9, ux: 0.9, accessibility: 0.9 },
    notes: [],
    ...over,
  };
}

describe('gradeBuild', () => {
  it('emits every accepted repository-grader signal and no undeclared names', () => {
    const names = Object.keys(gradeBuild(contract, artifact(), DEFAULT_CONFIG).hardGates).sort();
    expect(names).toEqual([...HARD_GATE_SIGNAL_NAMES].sort());
  });

  it('approves when all criteria + gates pass and score clears threshold', () => {
    const g = gradeBuild(contract, artifact(), DEFAULT_CONFIG);
    expect(g.verdict).toBe('approve');
    expect(g.blockerCount).toBe(0);
    expect(g.hardGates.playwright).toBe('pass');
  });

  it('requests changes (and never approves) when a blocker criterion fails', () => {
    const g = gradeBuild(contract, artifact({ satisfied: { 'AC-001': false, 'AC-002': true } }), DEFAULT_CONFIG);
    expect(g.verdict).toBe('request_changes');
    expect(g.blockerCount).toBe(1);
    expect(g.findings.some((f) => f.criterionId === 'AC-001')).toBe(true);
    expect(g.hardGates.playwright).toBe('fail');
  });

  it('treats a scope violation as a blocking gate failure', () => {
    const g = gradeBuild(contract, artifact({ scopeViolations: ['src/x.ts'] }), DEFAULT_CONFIG);
    expect(g.hardGates.scope_check).toBe('fail');
    expect(g.verdict).toBe('request_changes');
    expect(g.findings.some((f) => f.criterionId === 'GATE-scope_check')).toBe(true);
  });

  it('turns post-build grader profile drift into an actionable blocking gate', () => {
    const g = gradeBuild(contract, artifact({
      graderProfileValid: false,
      graderProfileError:
        'built checkout has no supported bounded profile',
    }), DEFAULT_CONFIG);
    expect(g.hardGates.grader_profile).toBe('fail');
    expect(g.verdict).toBe('request_changes');
    expect(g.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        criterionId: 'GATE-grader_profile',
        requiredFix: [
          'Restore the immutable-at-claim grader profile: '
          + 'built checkout has no supported bounded profile',
        ],
      }),
    ]));
  });

  it('a failing minor criterion lowers score but is not a blocker', () => {
    const g = gradeBuild(contract, artifact({ satisfied: { 'AC-001': true, 'AC-002': false } }), DEFAULT_CONFIG);
    expect(g.blockerCount).toBe(0);
    expect(g.scores.functionality).toBeLessThan(1);
  });
});
