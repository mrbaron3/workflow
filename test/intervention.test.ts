import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from '../src/store/store.js';
import { computeMetrics } from '../src/metrics/metrics.js';
import { INTERVENTION_KINDS, recordIntervention } from '../src/pipeline/intervene.js';
import { EvalRun, Issue, type Verdict } from '../src/domain/schema.js';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import { driveOnce, recordHumanDecision } from '../src/pipeline/execution/loop.js';
import type { PerspectiveGrader } from '../src/pipeline/panel.js';
import type { AgentRunner } from '../src/agents/runner.js';
import type { BuildArtifact } from '../src/domain/artifact.js';

function tmpStore(name: string): Store {
  const dir = path.join(os.tmpdir(), 'agentops-test', `${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return new Store(dir);
}

function addIssue(store: Store, id: string, status = 'released', assignedAgent: string | null = null): void {
  store.addIssue(
    Issue.parse({
      id,
      type: 'harness',
      title: id,
      area: 'harness',
      status,
      assignedAgent,
      contract: {
        productGoal: 'g',
        userStory: 'u',
        scope: { include: [], exclude: [] },
        acceptanceCriteria: [
          { id: 'AC-001', severity: 'blocker', behavior: 'b', verification: { method: 'unit_test', expected: ['x'] } },
        ],
        redLines: [],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
  );
}

let evalCounter = 0;
/** A driven issue = at least one EvalRun (what totals.issuesRun counts). */
function addRun(store: Store, issueId: string, verdict: Verdict): void {
  store.addEvalRun(
    EvalRun.parse({
      id: `EVAL-${++evalCounter}`,
      issueId,
      prId: `PR-${issueId}`,
      attempt: 1,
      sampleIndex: 0,
      agent: 'mock',
      verdict,
      findings: [],
      scores: { functionality: 1, codeQuality: 1, testQuality: 1, ux: 1, accessibility: 1 },
      overall: 1,
      cost: {},
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
}

describe('attested HOW-intervention recording (ISSUE-0011)', () => {
  it('ISSUE-0011/AC-INTV-001 an attested HOW intervention persists to the store bound to its issue, with kind, reason and record time', () => {
    const store = tmpStore('intv-record');
    addIssue(store, 'ISSUE-0001');
    // The ⑥⑦ pattern (human implements a gate condition inside a conditional approval)
    // must be expressible in the vocabulary.
    const conditional = INTERVENTION_KINDS.find((k) => /conditional/i.test(k));
    expect(conditional).toBeTruthy();

    const t0 = Date.now();
    const fact = recordIntervention(store, {
      issueId: 'ISSUE-0001',
      kind: conditional!,
      reason: 'human implemented the gate condition inside the conditional approval',
    });
    const t1 = Date.now();
    expect(fact.id).toMatch(/^INTV-/);

    // Audit from the store alone: a re-opened store still shows the fact.
    const reopened = new Store(store.root);
    expect(reopened.db.interventions).toHaveLength(1);
    const row = reopened.db.interventions[0]!;
    expect(row.issueId).toBe('ISSUE-0001');
    expect(row.kind).toBe(conditional);
    expect(row.reason).toMatch(/gate condition/);
    // The record time is the RECORDING moment as an ISO-8601 instant — not a constant,
    // not the issue's own createdAt, not unparseable garbage.
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const recordedAt = Date.parse(row.createdAt);
    expect(recordedAt).toBeGreaterThanOrEqual(t0);
    expect(recordedAt).toBeLessThanOrEqual(t1);
    // Enumerable per issue (observability: audit issue by issue).
    expect(reopened.interventionsForIssue('ISSUE-0001')).toHaveLength(1);
    expect(reopened.interventionsForIssue('ISSUE-9999')).toHaveLength(0);
  });

  it('ISSUE-0011/AC-INTV-001 rejects loudly with a reason: missing reason, out-of-vocabulary kind (incl. judgment points), unknown issue — nothing persisted', () => {
    const store = tmpStore('intv-reject');
    addIssue(store, 'ISSUE-0001');
    const kind = INTERVENTION_KINDS[0]!;

    expect(() => recordIntervention(store, { issueId: 'ISSUE-0001', kind, reason: '' })).toThrow(/reason/i);
    expect(() => recordIntervention(store, { issueId: 'ISSUE-0001', kind, reason: '   ' })).toThrow(/reason/i);
    // Judgment points (WHAT confirmation / delegation / approval / calibration) are not
    // interventions and must be rejected as out-of-vocabulary kinds.
    for (const judgment of ['adopt', 'assign', 'sign', 'decide', 'label']) {
      expect(() => recordIntervention(store, { issueId: 'ISSUE-0001', kind: judgment, reason: 'r' })).toThrow(/kind/i);
    }
    expect(() => recordIntervention(store, { issueId: 'ISSUE-0404', kind, reason: 'r' })).toThrow(/ISSUE-0404/);

    // Loud rejection means NOTHING was persisted either.
    const reopened = new Store(store.root);
    expect(reopened.db.interventions).toHaveLength(0);
  });

  it('ISSUE-0011/AC-INTV-001 additive schema: a legacy db.json without interventions still parses as zero interventions', () => {
    const store = tmpStore('intv-legacy');
    addIssue(store, 'ISSUE-0001');
    store.save();
    // Simulate a store written before the instruments existed.
    const raw = JSON.parse(fs.readFileSync(store.dbPath, 'utf8')) as Record<string, unknown>;
    delete raw.interventions;
    fs.writeFileSync(store.dbPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');

    const reopened = new Store(store.root);
    expect(reopened.db.interventions).toEqual([]);
    expect(reopened.getIssue('ISSUE-0001')).toBeTruthy(); // existing records untouched
  });
});

// Mock-backend drive fixtures (the patterns of test/execution-loop.test.ts): a clean build
// so the panel approves, and an all-approve grader so the issue reaches the human gate.
const CONFIG: HarnessConfig = { ...DEFAULT_CONFIG, generator: 'mock', samples: 1 };

function cleanRunner(): AgentRunner {
  const artifact: BuildArtifact = {
    branch: 'agent/x', summary: 's', filesChanged: ['src/x.ts'], satisfied: { 'AC-001': true },
    buildPasses: true, typecheckPasses: true, unitTestsPass: true, apiTestsPass: true, hasTests: true,
    secretsLeaked: false, scopeViolations: [], quality: { codeQuality: 0.9, testQuality: 0.9, ux: 0.9, accessibility: 0.9 }, notes: [],
  };
  return { agent: 'mock', generate: async () => artifact };
}

const allApprove: PerspectiveGrader = () => ({
  verdict: 'approve',
  findings: [],
  scores: { functionality: 1, codeQuality: 1, testQuality: 1, ux: 1, accessibility: 1 },
  overall: 1,
});

describe('autonomy-axis instruments (ISSUE-0011)', () => {
  it('ISSUE-0011/AC-INTV-002 a real judgment-point flow (drive → calibration label → human approve → released) leaves zero intervention rows and reads 0 / 1', async () => {
    const store = tmpStore('intv-judgment-flow');
    // adopt + assign: a contract-drafted issue delegated to the running backend.
    addIssue(store, 'ISSUE-0001', 'contract-drafted', 'mock');

    // drive → panel approve → human gate (no HOW touched by a human anywhere).
    await driveOnce(store, CONFIG, { runner: cleanRunner(), panel: { grader: allApprove } });
    expect(store.getIssue('ISSUE-0001')!.status).toBe('needs-human-review');

    // Calibration label on one of its runs (the `agentops label` path — a judgment point).
    const labeled = store.runsForIssue('ISSUE-0001')[0]!;
    labeled.humanVerdict = 'approve';

    // decide: human approval at the gate — released, humanVerdict written on the winning runs.
    recordHumanDecision(store, 'ISSUE-0001', 'approve');
    expect(store.getIssue('ISSUE-0001')!.status).toBe('released');
    store.save();

    // ⑦'s lesson as a regression: NO code path above may infer an intervention from
    // store state — judgment points are neither expressed nor counted as interventions.
    const reopened = new Store(store.root);
    expect(reopened.db.interventions).toHaveLength(0);
    expect(reopened.interventionsForIssue('ISSUE-0001')).toHaveLength(0);

    const m = computeMetrics(reopened);
    expect(m.interventionsPerIssue).toBe(0);
    expect(m.howNonInterventionRate).toBe(1);
  });

  it('ISSUE-0011/AC-INTV-002 judgment points alone leave no intervention: a driven-to-release issue counts 0 and lands on the non-intervention side', () => {
    // The semantic boundary is baked into the vocabulary itself: no judgment-point kind
    // (adopt / assign / sign / decide / label) exists, so recording one is impossible.
    for (const k of INTERVENTION_KINDS) expect(k).not.toMatch(/adopt|assign|\bsign\b|decide|label/i);

    const store = tmpStore('intv-boundary');
    // Released through adopt→assign→drive→decide: judgment points leave NO record.
    addIssue(store, 'ISSUE-0001');
    addRun(store, 'ISSUE-0001', 'approve');

    const m = computeMetrics(store);
    expect(m.interventionsPerIssue).toBe(0);
    expect(m.howNonInterventionRate).toBe(1);
  });

  it('ISSUE-0011/AC-INTV-003 instruments sit beside the existing metrics, machine-readable: per-issue count and non-intervention rate over driven issues', () => {
    const store = tmpStore('intv-mixed');
    addIssue(store, 'ISSUE-0001');
    addRun(store, 'ISSUE-0001', 'approve');
    addIssue(store, 'ISSUE-0002');
    addRun(store, 'ISSUE-0002', 'approve');
    recordIntervention(store, {
      issueId: 'ISSUE-0002',
      kind: INTERVENTION_KINDS[0]!,
      reason: 'human patched the worktree by hand',
    });

    const m = computeMetrics(store);
    expect(m.interventionsPerIssue).toBeCloseTo(0.5, 5); // 1 intervention / 2 driven issues
    expect(m.howNonInterventionRate).toBeCloseTo(0.5, 5); // 1 of 2 driven issues intervention-free

    // Machine-readable: the instruments survive the `status --json` round-trip as numbers.
    const json = JSON.parse(JSON.stringify(m)) as Record<string, unknown>;
    expect(json.interventionsPerIssue).toBe(0.5);
    expect(json.howNonInterventionRate).toBe(0.5);
  });

  it('ISSUE-0011/AC-INTV-003 interventionsPerIssue counts TOTAL records, not distinct intervened issues: two records on one of two driven issues read 1.0 / 0.5', () => {
    const store = tmpStore('intv-total-count');
    addIssue(store, 'ISSUE-0001');
    addRun(store, 'ISSUE-0001', 'approve');
    addIssue(store, 'ISSUE-0002');
    addRun(store, 'ISSUE-0002', 'approve');
    recordIntervention(store, {
      issueId: 'ISSUE-0002',
      kind: INTERVENTION_KINDS[0]!,
      reason: 'first hand-edit of the worktree',
    });
    recordIntervention(store, {
      issueId: 'ISSUE-0002',
      kind: INTERVENTION_KINDS[0]!,
      reason: 'second hand-edit of the SAME issue',
    });

    const m = computeMetrics(store);
    // The AC defines the numerator as 介入総数 (total records): 2 / 2 driven = 1.0,
    // NOT distinct-intervened-issues / driven (which would read 0.5 here).
    expect(m.interventionsPerIssue).toBeCloseTo(1.0, 5);
    // ...while the non-intervention rate classifies by has-any-record, not record count.
    expect(m.howNonInterventionRate).toBeCloseTo(0.5, 5);
  });

  it('ISSUE-0011/AC-INTV-003 numerator boundary pinned: a record on a never-driven issue counts in the total, while the denominator stays driven-only', () => {
    const store = tmpStore('intv-undriven-numerator');
    addIssue(store, 'ISSUE-0001');
    addRun(store, 'ISSUE-0001', 'approve');
    addIssue(store, 'ISSUE-0002', 'planned'); // exists in the store, never driven
    recordIntervention(store, {
      issueId: 'ISSUE-0002',
      kind: INTERVENTION_KINDS[0]!,
      reason: 'human reshaped the workspace before any drive',
    });

    const m = computeMetrics(store);
    // Pinned semantics: the numerator is the STORE-WIDE total of attested records (介入総数),
    // so this record counts (1 / 1 driven = 1) even though its issue is not in the denominator.
    // Filtering the numerator to driven issues would silently hide the record — if that is
    // ever wanted, this assertion forces it to be a conscious spec change, not a drift.
    expect(m.interventionsPerIssue).toBe(1);
    // The one driven issue has no record of its own, so it stays on the non-intervention side.
    expect(m.howNonInterventionRate).toBe(1);
  });

  it('ISSUE-0011/AC-INTV-003 both instruments are null when no issue has been driven (unobserved is neither 0 nor 1)', () => {
    const store = tmpStore('intv-undriven');
    addIssue(store, 'ISSUE-0001', 'planned'); // exists but never driven
    const m = computeMetrics(store);
    expect(m.interventionsPerIssue).toBeNull();
    expect(m.howNonInterventionRate).toBeNull();
  });

  it('ISSUE-0011/AC-INTV-004 retroactive: released issues accept intervention records like new ones, and the instruments recompute', () => {
    // The ⑥⑦ shape: issues already released BEFORE the instruments existed.
    const store = tmpStore('intv-retro');
    for (const id of ['ISSUE-0001', 'ISSUE-0002', 'ISSUE-0003']) {
      addIssue(store, id);
      addRun(store, id, 'approve');
    }
    expect(computeMetrics(store).howNonInterventionRate).toBe(1); // the lie the retroactive records correct

    const conditional = INTERVENTION_KINDS.find((k) => /conditional/i.test(k))!;
    recordIntervention(store, { issueId: 'ISSUE-0001', kind: conditional, reason: 'gate condition implemented by the eval owner' });
    recordIntervention(store, { issueId: 'ISSUE-0002', kind: conditional, reason: 'boundary pin promoted to the guard by hand' });

    const m = computeMetrics(store);
    expect(m.interventionsPerIssue).toBeCloseTo(2 / 3, 5);
    expect(m.howNonInterventionRate).toBeCloseTo(1 / 3, 5); // only ISSUE-0003 stayed intervention-free

    // Retroactive records are ordinary auditable facts.
    const reopened = new Store(store.root);
    expect(reopened.db.interventions.map((r) => r.issueId).sort()).toEqual(['ISSUE-0001', 'ISSUE-0002']);
  });
});
