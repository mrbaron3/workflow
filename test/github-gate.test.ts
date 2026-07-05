/**
 * GitHub PR gate backend (ADR-0006 G1-G3). The git/`gh` I/O is injected as a fake runner, so these
 * exercise the deterministic core: the state→decision map, the store-vs-github backend switch, the
 * projection (openGate) and the poll (pollGate) that feeds a merge/close into recordHumanDecision —
 * including the false-pass harvest onto EvalRun.humanVerdict. No network.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Store, nowISO } from '../src/store/store.js';
import { Issue, PR, EvalRun } from '../src/domain/schema.js';
import type { IssueStatus } from '../src/domain/states.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import { prStateToDecision, openGate, pollGate, renderGatePrBody, type GhGateRunner, type GhPrState } from '../src/pipeline/execution/gate.js';

const STORE: HarnessConfig = { ...DEFAULT_CONFIG }; // gate absent = store-direct (default)
const GITHUB: HarnessConfig = { ...DEFAULT_CONFIG, gate: { backend: 'github' } };

function tmpStore(name: string): Store {
  const dir = path.join(os.tmpdir(), 'agentops-test', `${name}-${process.pid}-${Math.floor(performance.now())}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return new Store(dir);
}

const contract = {
  productGoal: 'g', userStory: 'u', scope: { include: ['src/x.ts'], exclude: [] },
  acceptanceCriteria: [{ id: 'AC-1', severity: 'blocker' as const, behavior: 'b', verification: { method: 'unit_test' as const, expected: ['x'] } }],
  redLines: [],
};

const GATE_WALK: IssueStatus[] = ['ready-for-generation', 'generation-in-progress', 'ready-for-evaluation', 'evaluation-in-progress', 'build-approved', 'needs-human-review'];

/** Seed an issue that has reached the review gate with a github-projected PR + approving panel runs. */
function seedGatedIssue(store: Store, id: string, prNumber: number | null): PR {
  store.addIssue(Issue.parse({ id, type: 'harness', title: `${id} title`, area: 'harness', status: 'contract-drafted', assignedAgent: 'mock', contract, createdAt: nowISO(), updatedAt: nowISO() }));
  for (const s of GATE_WALK) store.setStatus(id, s);
  const pr = store.addPR(PR.parse({
    id: store.nextId('PR'), issueId: id, branch: `agent/${id.toLowerCase()}-s0`, baseBranch: 'main', generator: 'mock', attempts: 1, status: 'approved',
    externalRef: prNumber === null ? null : { provider: 'github', number: prNumber, url: `https://github.com/o/r/pull/${prNumber}` },
    createdAt: nowISO(), updatedAt: nowISO(),
  }));
  for (const p of ['functionality', 'codeQuality']) addRun(store, id, pr.id, p);
  return pr;
}

function addRun(store: Store, issueId: string, prId: string, perspective: string): EvalRun {
  return store.addEvalRun(EvalRun.parse({
    id: store.nextId('EVAL'), issueId, prId, attempt: 1, sampleIndex: 0, agent: 'mock', verdict: 'approve', perspective,
    findings: perspective === 'codeQuality' ? [{ criterionId: 'codeQuality:AC-1', severity: 'minor', expected: 'e', observed: 'nit' }] : [],
    scores: { functionality: 1, codeQuality: 1, testQuality: 1, ux: 1, accessibility: 1 }, overall: 1, cost: {}, createdAt: nowISO(),
  }));
}

function fakeRunner(state: GhPrState, prNumber = 42): { runner: GhGateRunner; calls: { push: number; create: number; view: number } } {
  const calls = { push: 0, create: 0, view: 0 };
  const runner: GhGateRunner = {
    pushBranch: () => { calls.push++; },
    createPr: (_cwd, args) => { calls.create++; return { provider: 'github', number: prNumber, url: `https://github.com/o/r/pull/${prNumber}#${args.head}` }; },
    viewPr: () => { calls.view++; return state; },
  };
  return { runner, calls };
}

describe('prStateToDecision: the pure heart of the gate', () => {
  it('merged→approve, closed→reject, open→pending(null)', () => {
    expect(prStateToDecision('merged')).toBe('approve');
    expect(prStateToDecision('closed')).toBe('reject');
    expect(prStateToDecision('open')).toBeNull();
  });
});

describe('openGate: project an approved build to the gate UI', () => {
  it('store backend is a no-op — no push, no PR, no externalRef', () => {
    const store = tmpStore('open-store');
    const pr = seedGatedIssue(store, 'ISSUE-1', null);
    const { runner, calls } = fakeRunner('open');
    const ref = openGate(store, STORE, { pr, worktree: '/wt', title: 't' }, runner);
    expect(ref).toBeNull();
    expect(calls).toEqual({ push: 0, create: 0, view: 0 });
    expect(pr.externalRef).toBeNull();
  });

  it('github backend pushes, opens a PR and records externalRef', () => {
    const store = tmpStore('open-github');
    const pr = seedGatedIssue(store, 'ISSUE-1', null);
    const { runner, calls } = fakeRunner('open', 7);
    const ref = openGate(store, GITHUB, { pr, worktree: '/wt', title: 'ISSUE-1: t' }, runner);
    expect(calls.push).toBe(1);
    expect(calls.create).toBe(1);
    expect(ref?.number).toBe(7);
    expect(pr.externalRef?.number).toBe(7);
    expect(pr.externalRef?.provider).toBe('github');
  });

  it('is idempotent: a PR that already has an externalRef is not re-created', () => {
    const store = tmpStore('open-idem');
    const pr = seedGatedIssue(store, 'ISSUE-1', 5); // already projected
    const { runner, calls } = fakeRunner('open');
    const ref = openGate(store, GITHUB, { pr, worktree: '/wt', title: 't' }, runner);
    expect(ref?.number).toBe(5);
    expect(calls).toEqual({ push: 0, create: 0, view: 0 }); // no re-push / re-create
  });
});

describe('pollGate: a merge/close becomes the human decision', () => {
  it('store backend is a no-op (nothing to poll)', () => {
    const store = tmpStore('poll-store');
    seedGatedIssue(store, 'ISSUE-1', 1);
    expect(pollGate(store, STORE, fakeRunner('merged').runner, '/repo')).toEqual([]);
  });

  it('merged → released + humanVerdict=approve on the winning runs (true-pass harvest)', () => {
    const store = tmpStore('poll-merged');
    seedGatedIssue(store, 'ISSUE-1', 1);
    const res = pollGate(store, GITHUB, fakeRunner('merged').runner, '/repo')[0]!;
    expect(res.decision).toBe('approve');
    expect(res.changed).toBe(true);
    expect(store.getIssue('ISSUE-1')!.status).toBe('released');
    expect(store.runsForIssue('ISSUE-1').every((r) => r.humanVerdict === 'approve')).toBe(true);
    expect(store.prForIssue('ISSUE-1')!.status).toBe('merged');
  });

  it('closed → repair lane + humanVerdict=request_changes (a false-pass the panel let through)', () => {
    const store = tmpStore('poll-closed');
    seedGatedIssue(store, 'ISSUE-1', 1);
    const res = pollGate(store, GITHUB, fakeRunner('closed').runner, '/repo')[0]!;
    expect(res.decision).toBe('reject');
    expect(store.getIssue('ISSUE-1')!.status).toBe('changes-requested');
    expect(store.runsForIssue('ISSUE-1').every((r) => r.humanVerdict === 'request_changes')).toBe(true);
  });

  it('still-open PR is left pending — no decision, no state change', () => {
    const store = tmpStore('poll-open');
    seedGatedIssue(store, 'ISSUE-1', 1);
    const res = pollGate(store, GITHUB, fakeRunner('open').runner, '/repo')[0]!;
    expect(res.decision).toBeNull();
    expect(res.changed).toBe(false);
    expect(store.getIssue('ISSUE-1')!.status).toBe('needs-human-review');
  });

  it('is idempotent: a released issue is no longer needs-human-review, so a re-poll skips it', () => {
    const store = tmpStore('poll-idem');
    seedGatedIssue(store, 'ISSUE-1', 1);
    pollGate(store, GITHUB, fakeRunner('merged').runner, '/repo');
    const second = pollGate(store, GITHUB, fakeRunner('merged').runner, '/repo');
    expect(second).toEqual([]); // nothing left at the gate
  });

  it('only polls github-projected PRs — an unprojected needs-human-review issue is skipped', () => {
    const store = tmpStore('poll-unprojected');
    seedGatedIssue(store, 'ISSUE-1', null); // no externalRef
    expect(pollGate(store, GITHUB, fakeRunner('merged').runner, '/repo')).toEqual([]);
  });
});

describe('renderGatePrBody: human-readable panel render', () => {
  it('lists each perspective verdict and its findings', () => {
    const store = tmpStore('body');
    seedGatedIssue(store, 'ISSUE-1', 1);
    const body = renderGatePrBody(store, 'ISSUE-1');
    expect(body).toContain('approved');
    expect(body).toContain('functionality');
    expect(body).toContain('codeQuality');
    expect(body).toContain('codeQuality:AC-1'); // the finding
  });
});
