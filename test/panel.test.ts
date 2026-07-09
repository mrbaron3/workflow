/**
 * Evaluator panel (ADR-0006) — grades the 9 signed ACs of docs/specs/evaluator-panel.
 * Each `AC-PANEL-00N` below names the acceptance criterion the test grounds.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from '../src/store/store.js';
import { Issue, PR, type IssueContract } from '../src/domain/schema.js';
import type { BuildArtifact } from '../src/domain/artifact.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import {
  runPanel,
  aggregatePanelVerdict,
  deterministicPerspectiveGrade,
  PERSPECTIVES,
  type PerspectiveGrader,
} from '../src/pipeline/panel.js';
import { buildPanelRepairBrief } from '../src/pipeline/repair.js';
import { computeMetrics } from '../src/metrics/metrics.js';
import { curateEvalTasks } from '../src/pipeline/curator.js';

const CONFIG: HarnessConfig = { ...DEFAULT_CONFIG, generator: 'claude' };

function tmpStore(name: string): Store {
  const dir = path.join(os.tmpdir(), 'agentops-test', `${name}-${process.pid}-${Math.floor(performance.now())}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return new Store(dir);
}

const contract: IssueContract = {
  productGoal: 'g',
  userStory: 'u',
  scope: { include: [], exclude: [] },
  acceptanceCriteria: [
    { id: 'AC-1', severity: 'blocker', behavior: 'do the thing', verification: { method: 'unit_test', expected: ['x'] } },
  ],
  redLines: [],
};

/** A clean, all-passing artifact (hard gates pass, ACs satisfied, quality high). */
function goodArtifact(overrides: Partial<BuildArtifact> = {}): BuildArtifact {
  return {
    branch: 'agent/x',
    summary: 's',
    filesChanged: ['src/x.ts'],
    satisfied: { 'AC-1': true },
    buildPasses: true,
    typecheckPasses: true,
    unitTestsPass: true,
    apiTestsPass: true,
    hasTests: true,
    secretsLeaked: false,
    scopeViolations: [],
    quality: { codeQuality: 0.9, testQuality: 0.9, ux: 0.9, accessibility: 0.9 },
    notes: [],
    ...overrides,
  };
}

function seed(store: Store, issueId = 'ISSUE-1', status: 'evaluation-in-progress' | 'contract-drafted' = 'evaluation-in-progress'): { issueId: string; prId: string } {
  store.addIssue(
    Issue.parse({
      id: issueId, type: 'harness', title: 't', area: 'harness', status: 'contract-drafted',
      contract, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  // walk to evaluation-in-progress unless the test wants it left at contract-drafted
  if (status === 'evaluation-in-progress') {
    for (const s of ['ready-for-generation', 'generation-in-progress', 'ready-for-evaluation', 'evaluation-in-progress'] as const) {
      store.setStatus(issueId, s);
    }
  }
  const pr = store.addPR(
    PR.parse({ id: 'PR-1', issueId, branch: 'agent/x', generator: 'claude', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }),
  );
  return { issueId, prId: pr.id };
}

function panelInput(issueId: string, prId: string, artifact: BuildArtifact, attempt = 1) {
  return { issueId, prId, contract, artifact, sampleIndex: 0, attempt, agent: 'claude' as const, featureArea: 'harness' };
}

describe('AC-PANEL-001: completed sample graded across all perspectives', () => {
  it('leaves exactly one perspective-tagged EvalRun per perspective, each with findings-shaped evidence', () => {
    const store = tmpStore('panel-001');
    const { issueId, prId } = seed(store);
    const res = runPanel(store, CONFIG, panelInput(issueId, prId, goodArtifact()));

    const runs = store.runsForIssue(issueId);
    expect(runs).toHaveLength(PERSPECTIVES.length);
    expect(new Set(runs.map((r) => r.perspective))).toEqual(new Set(PERSPECTIVES.map((p) => p.key)));
    for (const r of runs) expect(r.perspective).not.toBeNull();
    expect(res.verdict).toBe('approve');
  });
});

describe('AC-PANEL-002: hard-gate-failing attempt does not reach perspective grading', () => {
  it('creates no perspective-tagged run and forwards gate findings for repair', () => {
    const store = tmpStore('panel-002');
    const { issueId, prId } = seed(store);
    const res = runPanel(store, CONFIG, panelInput(issueId, prId, goodArtifact({ typecheckPasses: false })));

    const runs = store.runsForIssue(issueId);
    expect(runs.every((r) => r.perspective === null)).toBe(true);
    expect(res.gateFailed).toBe(true);
    expect(res.verdict).toBe('request_changes');
    expect(runs[0]!.findings.some((f) => f.criterionId === 'GATE-typecheck')).toBe(true);
  });
});

describe('AC-PANEL-003 / 004: aggregation is blocker-first and never averages', () => {
  it('one perspective request_changes vetoes the sample (AC-PANEL-003)', () => {
    // a grader where `security` blocks but everything else approves
    const grader: PerspectiveGrader = (p, c, a, cfg) =>
      p === 'security'
        ? { verdict: 'request_changes', findings: [{ criterionId: 'SEC-x', severity: 'blocker', expected: 'e', observed: 'o', reproductionSteps: [], evidence: {}, requiredFix: ['fix'] }], scores: { functionality: 1, codeQuality: 1, testQuality: 1, ux: 1, accessibility: 1 }, overall: 0 }
        : deterministicPerspectiveGrade(p, c, a, cfg);
    const store = tmpStore('panel-003');
    const { issueId, prId } = seed(store);
    const res = runPanel(store, CONFIG, panelInput(issueId, prId, goodArtifact()), { grader });
    expect(res.verdict).toBe('request_changes');
  });

  it('all perspectives approve -> approve, derived from runs not stored (AC-PANEL-004)', () => {
    const store = tmpStore('panel-004');
    const { issueId, prId } = seed(store);
    runPanel(store, CONFIG, panelInput(issueId, prId, goodArtifact()));
    const runs = store.runsForIssue(issueId);
    // derivation is pure over the persisted runs; no stored aggregate row
    expect(aggregatePanelVerdict(runs)).toBe('approve');
    expect(runs.some((r) => r.perspective === null)).toBe(false); // no composite/aggregate run persisted
  });

  it('aggregatePanelVerdict is a pure function of verdicts', () => {
    expect(aggregatePanelVerdict([{ verdict: 'approve' }, { verdict: 'approve' }])).toBe('approve');
    expect(aggregatePanelVerdict([{ verdict: 'approve' }, { verdict: 'request_changes' }])).toBe('request_changes');
    expect(aggregatePanelVerdict([{ verdict: 'approve' }, { verdict: 'needs_human' }])).toBe('needs_human');
    expect(aggregatePanelVerdict([])).toBe('needs_human');
  });
});

describe('AC-PANEL-005: cross-perspective repair brief', () => {
  it('blocker-first, one instruction group per distinct finding, tagged with source perspectives', () => {
    const store = tmpStore('panel-005');
    const { issueId, prId } = seed(store);
    // codeQuality + type-design both flag the same criterion (major); security flags a blocker
    const grader: PerspectiveGrader = (p) => {
      if (p === 'security') return { verdict: 'request_changes', findings: [{ criterionId: 'SEC-x', severity: 'blocker', expected: 'e', observed: 'o', reproductionSteps: [], evidence: {}, requiredFix: ['rotate secret'] }], scores: zeros(), overall: 0 };
      if (p === 'codeQuality' || p === 'type-design') return { verdict: 'request_changes', findings: [{ criterionId: 'CQ-1', severity: 'major', expected: 'e', observed: 'o', reproductionSteps: [], evidence: {}, requiredFix: ['tidy types'] }], scores: zeros(), overall: 0.5 };
      return { verdict: 'approve', findings: [], scores: ones(), overall: 1 };
    };
    runPanel(store, CONFIG, panelInput(issueId, prId, goodArtifact()), { grader });
    const brief = buildPanelRepairBrief(store.runsForIssue(issueId));

    // blocker first
    expect(brief.instructions[0]!.severity).toBe('blocker');
    expect(brief.instructions[0]!.criterionId).toBe('SEC-x');
    // only blockers forwarded when a blocker exists, so CQ-1 (major) is held back this round
    expect(brief.instructions.every((i) => i.severity === 'blocker')).toBe(true);
  });

  it('merges content-identical findings from several perspectives into one instruction (no blocker present)', () => {
    const store = tmpStore('panel-005b');
    const { issueId, prId } = seed(store);
    const grader: PerspectiveGrader = (p) =>
      p === 'codeQuality' || p === 'type-design'
        ? { verdict: 'request_changes', findings: [{ criterionId: 'CQ-1', severity: 'major', expected: 'e', observed: 'o', reproductionSteps: [], evidence: {}, requiredFix: ['tidy types'] }], scores: zeros(), overall: 0.5 }
        : { verdict: 'approve', findings: [], scores: ones(), overall: 1 };
    runPanel(store, CONFIG, panelInput(issueId, prId, goodArtifact()), { grader });
    const brief = buildPanelRepairBrief(store.runsForIssue(issueId));

    const cq = brief.instructions.filter((i) => i.criterionId === 'CQ-1');
    expect(cq).toHaveLength(1); // deduped
    expect(cq[0]!.perspectives).toEqual(['codeQuality', 'type-design']); // both sources tagged
  });
});

describe('AC-PANEL-006: invalid perspective output escalates, never silently passes', () => {
  it('a grader that keeps emitting invalid output sends the issue to needs-human-review', () => {
    const store = tmpStore('panel-006');
    const { issueId, prId } = seed(store);
    // security returns a structurally invalid result (missing scores/overall); others are fine
    const grader: PerspectiveGrader = (p, c, a, cfg) =>
      p === 'security' ? ({ verdict: 'approve' } as never) : deterministicPerspectiveGrade(p, c, a, cfg);
    const res = runPanel(store, CONFIG, panelInput(issueId, prId, goodArtifact()), { grader });

    expect(res.escalated).toBe(true);
    expect(res.verdict).toBe('needs_human');
    expect(store.getIssue(issueId)!.status).toBe('needs-human-review');
    // the invalid perspective produced no run, and the sample did not become approve
    expect(store.runsForIssue(issueId).some((r) => r.perspective === 'security')).toBe(false);
    expect(res.verdict).not.toBe('approve');
  });
});

describe('AC-PANEL-007: partial-resume does not double-grade', () => {
  it('re-running grades only the missing perspectives; one run per (pr, attempt, perspective)', () => {
    const store = tmpStore('panel-007');
    const { issueId, prId } = seed(store);
    // first pass: only functionality succeeds; the rest throw (transient), so they escalate this round
    let failRest = true;
    const grader: PerspectiveGrader = (p, c, a, cfg) => {
      if (p === 'functionality') return deterministicPerspectiveGrade(p, c, a, cfg);
      if (failRest) throw new Error('transient');
      return deterministicPerspectiveGrade(p, c, a, cfg);
    };
    runPanel(store, CONFIG, panelInput(issueId, prId, goodArtifact()), { grader, maxGraderRetries: 0 });
    const afterFirst = store.runsForIssue(issueId).filter((r) => r.perspective === 'functionality').length;
    expect(afterFirst).toBe(1);

    // second pass: the transient failure clears; missing perspectives now grade
    failRest = false;
    runPanel(store, CONFIG, panelInput(issueId, prId, goodArtifact()), { grader, maxGraderRetries: 0 });

    const runs = store.runsForIssue(issueId);
    expect(runs).toHaveLength(PERSPECTIVES.length); // no duplicates
    for (const p of PERSPECTIVES) {
      expect(runs.filter((r) => r.perspective === p.key)).toHaveLength(1); // exactly one per perspective
    }
  });
});

describe('AC-PANEL-008: panel grading does not mutate the artifact', () => {
  it('changedFiles / scope are unchanged before and after grading', () => {
    const store = tmpStore('panel-008');
    const { issueId, prId } = seed(store);
    const artifact = goodArtifact();
    const before = JSON.stringify({ changed: artifact.filesChanged, scope: artifact.scopeViolations, satisfied: artifact.satisfied });
    runPanel(store, CONFIG, panelInput(issueId, prId, artifact));
    const after = JSON.stringify({ changed: artifact.filesChanged, scope: artifact.scopeViolations, satisfied: artifact.satisfied });
    expect(after).toBe(before);
  });
});

describe('AC-PANEL-009: perspective runs do not double-count in readers', () => {
  it('pass@k / attempt denominators are unaffected by perspective count', () => {
    const store = tmpStore('panel-009');
    const { issueId, prId } = seed(store, 'ISSUE-1', 'contract-drafted');
    // manually walk to evaluation so the panel can run against a released-style issue
    for (const s of ['ready-for-generation', 'generation-in-progress', 'ready-for-evaluation', 'evaluation-in-progress'] as const) store.setStatus(issueId, s);
    runPanel(store, CONFIG, panelInput(issueId, prId, goodArtifact()));
    store.setStatus(issueId, 'approved');
    store.setStatus(issueId, 'ready-to-merge');
    store.setStatus(issueId, 'released');

    const m = computeMetrics(store);
    // 7 perspective runs, but this is ONE sample / ONE attempt that passed
    expect(store.runsForIssue(issueId).length).toBe(PERSPECTIVES.length);
    expect(m.totals.samples).toBe(1);
    expect(m.issues[0]!.totalAttempts).toBe(1);
    expect(m.passAt1).toBe(1);
  });

  it('curator promotes one regression task per criterion, not one per perspective', () => {
    const store = tmpStore('panel-009b');
    const { issueId, prId } = seed(store);
    // every perspective flags the same blocker criterion AC-1
    const grader: PerspectiveGrader = () => ({
      verdict: 'request_changes',
      findings: [{ criterionId: 'AC-1', severity: 'blocker', expected: 'e', observed: 'o', reproductionSteps: [], evidence: {}, requiredFix: ['fix'] }],
      scores: zeros(),
      overall: 0,
    });
    runPanel(store, CONFIG, panelInput(issueId, prId, goodArtifact()), { grader });

    const { created } = curateEvalTasks(store);
    const forAc1 = created.filter((t) => t.id.includes('AC-1'));
    expect(forAc1).toHaveLength(1); // one task for AC-1 despite N perspective findings
  });
});

function zeros() {
  return { functionality: 0, codeQuality: 0, testQuality: 0, ux: 0, accessibility: 0 };
}
function ones() {
  return { functionality: 1, codeQuality: 1, testQuality: 1, ux: 1, accessibility: 1 };
}
