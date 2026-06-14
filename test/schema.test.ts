import { describe, it, expect } from 'vitest';
import { IssueContract, EvalRun } from '../src/domain/schema.js';
import { canTransition, assertTransition } from '../src/domain/states.js';

describe('IssueContract schema', () => {
  const valid = {
    productGoal: 'goal',
    userStory: 'story',
    scope: { include: ['a'], exclude: ['b'] },
    acceptanceCriteria: [
      { id: 'AC-001', severity: 'blocker', behavior: 'works', verification: { method: 'playwright', expected: ['x'] } },
    ],
    redLines: ['no faking'],
  };

  it('accepts a well-formed contract', () => {
    const parsed = IssueContract.parse(valid);
    expect(parsed.acceptanceCriteria).toHaveLength(1);
  });

  it('rejects a contract with no acceptance criteria', () => {
    expect(() => IssueContract.parse({ ...valid, acceptanceCriteria: [] })).toThrow();
  });

  it('rejects an unknown verification method', () => {
    const bad = {
      ...valid,
      acceptanceCriteria: [
        { id: 'AC-1', severity: 'blocker', behavior: 'b', verification: { method: 'vibes', expected: ['x'] } },
      ],
    };
    expect(() => IssueContract.parse(bad)).toThrow();
  });

  it('rejects an out-of-range score on an EvalRun', () => {
    const base = {
      id: 'EVAL-1',
      issueId: 'ISSUE-1',
      prId: 'PR-1',
      attempt: 1,
      sampleIndex: 0,
      agent: 'mock',
      verdict: 'approve',
      scores: { functionality: 2, codeQuality: 1, testQuality: 1, ux: 1, accessibility: 1 },
      overall: 0.9,
      cost: { usd: 0, tokens: 0, seconds: 0 },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(() => EvalRun.parse(base)).toThrow();
  });
});

describe('state machine', () => {
  it('allows the documented happy path', () => {
    expect(canTransition('contract-drafted', 'ready-for-generation')).toBe(true);
    expect(canTransition('evaluation-in-progress', 'approved')).toBe(true);
    expect(canTransition('approved', 'ready-to-merge')).toBe(true);
  });

  it('always allows escalation to needs-human-review', () => {
    expect(canTransition('generation-in-progress', 'needs-human-review')).toBe(true);
    expect(canTransition('released', 'needs-human-review')).toBe(true);
  });

  it('forbids skipping states', () => {
    expect(canTransition('planned', 'released')).toBe(false);
    expect(() => assertTransition('planned', 'approved')).toThrow();
  });

  it('treats released as terminal (except escalation)', () => {
    expect(canTransition('released', 'ready-to-merge')).toBe(false);
  });
});
