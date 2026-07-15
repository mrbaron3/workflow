/**
 * The ③ improvement loop (North Star): the harness improves itself from evidence.
 *   Curator  — promotes blocker ACs that have FAILED into the Eval Task Registry as regression
 *              tasks (the steering star: "never repeat the same failure twice").
 *   Analyst  — reads metrics and proposes harness/eval improvements, which become backlog issues
 *              on the same roadmap (the harness fixes itself through the same drive loop).
 * These had no dedicated tests; this locks both halves and the loop closing (failure → regression
 * task + improvement issue) deterministically — the prerequisite for observing it grounded.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, nowISO } from '../src/store/store.js';
import { Issue, EvalRun } from '../src/domain/schema.js';
import { curateEvalTasks } from '../src/pipeline/curator.js';
import { analyzeHarness, createSuggestionIssues } from '../src/pipeline/analyst.js';
import { improveTick } from '../src/pipeline/improve.js';
import type { Metrics } from '../src/metrics/metrics.js';

const dirs: string[] = [];
function freshStore(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-improve-'));
  dirs.push(root);
  return new Store(root);
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** Seed an issue whose contract has two blocker ACs + one major AC. */
function seedIssue(store: Store, id = 'ISSUE-0001'): Issue {
  return store.addIssue(
    Issue.parse({
      id, type: 'story', title: 'Roman converter', area: 'backend',
      status: 'contract-drafted', assignedAgent: 'claude', epicId: null, sprint: null,
      createdAt: nowISO(), updatedAt: nowISO(),
      contract: {
        productGoal: 'g', userStory: 'u', scope: { include: ['src/**'], exclude: [] },
        acceptanceCriteria: [
          { id: 'AC-1', severity: 'blocker', behavior: 'converts to roman', verification: { method: 'unit_test', expected: ['toRoman(4)==="IV"'] } },
          { id: 'AC-2', severity: 'blocker', behavior: 'parses from roman', verification: { method: 'unit_test', expected: ['fromRoman("IV")===4'] } },
          { id: 'AC-3', severity: 'major', behavior: 'rejects malformed', verification: { method: 'unit_test', expected: ['fromRoman("IIII") throws'] } },
        ],
        redLines: [],
      },
    }),
  );
}

/** Seed one graded run for an issue, optionally with a finding against a criterion (a failure). */
function seedRun(store: Store, issueId: string, failedCriterion?: string): void {
  store.addEvalRun(
    EvalRun.parse({
      id: `EVAL-${store.db.evalRuns.length + 1}`, issueId, prId: 'PR-1', attempt: 1, sampleIndex: 0,
      agent: 'claude', verdict: failedCriterion ? 'request_changes' : 'approve',
      findings: failedCriterion ? [{ criterionId: failedCriterion, severity: 'blocker', expected: 'x', observed: 'y' }] : [],
      scores: { functionality: 0, codeQuality: 0, testQuality: 0, ux: 0, accessibility: 0 },
      overall: failedCriterion ? 0.3 : 1, cost: {}, createdAt: nowISO(),
    }),
  );
}

/** A healthy baseline Metrics; override individual fields to trip a specific Analyst rule. */
function metrics(over: Partial<Metrics> = {}): Metrics {
  return {
    totals: { epics: 0, issues: 1, issuesRun: 1, released: 0, samples: 2, evalRuns: 2 },
    passAt1: 1, passAtK: 1, passHatK: 1, headlineK: 2, repairSuccessRate: 1, prPassRate: 1,
    avgRepairAttempts: 1, instabilityRate: 0, cost: { usd: 0, tokens: 0, seconds: 0 },
    falsePassRate: 0, falseFailRate: 0, graderAgreement: 1, regressionCaptureRate: null,
    regressionExecutedRate: null, regressionFailingTasks: 0, regressionUnverifiedTasks: 0,
    interventionsPerIssue: 0, howNonInterventionRate: 1,
    lastTurnPeakConcurrency: null, lastTurnIssuesDriven: null, lastTurnCap: null,
    falsePassTrend: [], passCurve: [], byAgent: [], byInvocationProvider: [],
    heatmap: { areas: [], types: [], counts: {}, max: 0 }, issues: [],
    ...over,
  };
}

describe('Curator — grows the regression registry from real failures', () => {
  it('promotes only BLOCKER ACs of run issues, tagging failed ones as [regression]', () => {
    const store = freshStore();
    const issue = seedIssue(store);
    seedRun(store, issue.id, 'AC-1'); // AC-1 actually failed

    const { created } = curateEvalTasks(store);
    const ids = created.map((t) => t.id);
    expect(ids).toContain(`EVAL-TASK-${issue.id}-AC-1`);
    expect(ids).toContain(`EVAL-TASK-${issue.id}-AC-2`);
    expect(ids).not.toContain(`EVAL-TASK-${issue.id}-AC-3`); // major, skipped
    const ac1 = created.find((t) => t.id.endsWith('AC-1'))!;
    const ac2 = created.find((t) => t.id.endsWith('AC-2'))!;
    expect(ac1.userGoal).toMatch(/^\[regression\]/); // failed -> regression
    expect(ac2.userGoal).not.toMatch(/^\[regression\]/); // never failed -> plain
    expect(ac1.severity).toBe('blocker');
  });

  it('is idempotent (re-curating creates nothing) and skips issues with no runs', () => {
    const store = freshStore();
    const run = seedIssue(store, 'ISSUE-0001');
    seedRun(store, run.id);
    seedIssue(store, 'ISSUE-0002'); // no runs -> not curated

    expect(curateEvalTasks(store).created.length).toBe(2); // ISSUE-0001 AC-1 + AC-2 only
    expect(curateEvalTasks(store).created.length).toBe(0); // already promoted
    expect(store.db.evalTasks.some((t) => t.sourceIssueId === 'ISSUE-0002')).toBe(false);
  });
});

describe('Analyst — turns weak metrics into harness/eval improvement suggestions', () => {
  it('stays silent when metrics are healthy, and short-circuits with no samples', () => {
    expect(analyzeHarness(freshStore(), metrics())).toEqual([]);
    expect(analyzeHarness(freshStore(), metrics({ totals: { epics: 0, issues: 0, issuesRun: 0, released: 0, samples: 0, evalRuns: 0 } }))).toEqual([]);
  });

  it('flags low pass^k (eval), low pass@1 (harness), and a missing calibration set', () => {
    const s = freshStore();
    expect(analyzeHarness(s, metrics({ passHatK: 0.3 })).some((x) => x.type === 'eval' && /pass\^/.test(x.title))).toBe(true);
    expect(analyzeHarness(s, metrics({ passAt1: 0.3 })).some((x) => x.type === 'harness' && /first-attempt/.test(x.title))).toBe(true);
    expect(analyzeHarness(s, metrics({ falsePassRate: null })).some((x) => /calibration/.test(x.title))).toBe(true);
  });

  it('targets the hottest failure cell from the heatmap', () => {
    const hot = analyzeHarness(freshStore(), metrics({ heatmap: { areas: ['backend'], types: ['functionality'], counts: { backend: { functionality: 4 } }, max: 4 } }));
    expect(hot.some((x) => /Address top failure: backend × functionality/.test(x.title))).toBe(true);
  });

  it('createSuggestionIssues lands planned harness/eval issues on the roadmap, de-duped by title', () => {
    const store = freshStore();
    const sugs = analyzeHarness(store, metrics({ passAt1: 0.3, falsePassRate: null }));
    const created = createSuggestionIssues(store, sugs);
    expect(created.length).toBeGreaterThan(0);
    expect(created.every((i) => i.status === 'planned' && (i.type === 'harness' || i.type === 'eval'))).toBe(true);
    expect(createSuggestionIssues(store, sugs).length).toBe(0); // titles already exist -> de-duped
  });
});

describe('the loop closes: a real failure becomes a regression task AND an improvement issue', () => {
  it('curate + analyze + create turns one failed run into durable, drivable follow-ups', () => {
    const store = freshStore();
    const issue = seedIssue(store);
    seedRun(store, issue.id, 'AC-1'); // the failure

    const regressions = curateEvalTasks(store).created;
    const improvements = createSuggestionIssues(store, analyzeHarness(store, metrics({ falsePassRate: null })));

    // ① the failure is captured as a regression eval task (never repeat it silently)
    expect(regressions.some((t) => t.id.endsWith('AC-1') && t.userGoal.startsWith('[regression]'))).toBe(true);
    // ② a harness/eval improvement is queued as a planned issue the execution loop can drive
    expect(improvements.length).toBeGreaterThan(0);
    expect(improvements.every((i) => i.status === 'planned')).toBe(true);
  });
});

describe('improveTick — the ③ tail every live turn ends with (ADR-0007 I2)', () => {
  it('captures failures into the registry, reports suggestions, and creates NO issues', () => {
    const store = freshStore();
    const issue = seedIssue(store);
    seedRun(store, issue.id, 'AC-1'); // a real failure sits in the store after the turn
    const issuesBefore = store.db.issues.length;

    const lines: string[] = [];
    const res = improveTick(store, (m) => lines.push(m));

    // Curator ran: the failed blocker AC is now a [regression] eval task
    expect(res.curated.some((t) => t.id.endsWith('AC-1') && t.userGoal.startsWith('[regression]'))).toBe(true);
    expect(store.db.evalTasks.length).toBeGreaterThan(0);
    // Analyst ran report-only: suggestions surfaced in the log, but the backlog is untouched
    expect(res.suggestions.length).toBeGreaterThan(0);
    expect(store.db.issues.length).toBe(issuesBefore); // no auto-created issues (WHAT stays human)
    expect(lines.some((l) => l.includes('curated'))).toBe(true);
    expect(lines.some((l) => l.includes('analyst'))).toBe(true);
  });

  it('is idempotent: a second tick with no new failures curates nothing', () => {
    const store = freshStore();
    const issue = seedIssue(store);
    seedRun(store, issue.id, 'AC-1');
    improveTick(store);
    const registrySize = store.db.evalTasks.length;

    const second = improveTick(store);
    expect(second.curated).toEqual([]);
    expect(store.db.evalTasks.length).toBe(registrySize);
  });
});
