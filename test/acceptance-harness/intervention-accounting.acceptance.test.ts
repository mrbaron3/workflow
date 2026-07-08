/**
 * Env-gated acceptance grader for ISSUE-0011 "Record attested human HOW-interventions and
 * expose autonomy-axis instruments" — spec
 * docs/specs/autonomy-axis-instruments-human-how-intervention-accounting (AC-INTV-001..004).
 *
 * Red at baseline BY DESIGN, collected only under ACCEPT_HARNESS=1 (ADR-0007 I3). After the
 * build is human-approved and released, the skipIf is dropped and this file stays in
 * protectedPaths as the permanent regression guard.
 *
 * Semantics this file pins (spec is the SoT — NORTH_STAR_PLAN §5 settled there):
 *   - Human JUDGMENT POINTS (adopt / assign / sign / decide / label) are NOT interventions.
 *     The boundary is baked into the recording VOCABULARY: no judgment-point kind exists,
 *     so miscounting a judgment as an intervention is structurally impossible.
 *   - Only attested, explicit records count (⑦'s lesson: a diagnostician that guesses
 *     produces false positives/negatives). Nothing infers interventions from other state.
 *
 * Seams this file pins (harness-owned WHAT confirmation):
 *   - src/pipeline/intervene.ts exports `INTERVENTION_KINDS` (the HOW-involvement vocabulary,
 *     including the ⑥⑦ conditional-approval kind) and `recordIntervention(store, input)` —
 *     the single mutation point: validates issue existence, requires a reason, rejects
 *     unknown kinds loudly; issue STATUS is never a precondition (retroactivity, AC-INTV-004).
 *   - The DB grows an additive `interventions` array (id, issueId, kind, reason, createdAt)
 *     that round-trips through Store persistence (audit from the store alone).
 *   - computeMetrics gains `interventionsPerIssue` (total interventions / driven issues) and
 *     `howNonInterventionRate` (driven issues with zero interventions / driven issues);
 *     both null when no issue has been driven (never conflate "unobserved" with 0 or 1).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, nowISO } from '../../src/store/store.js';
import { EvalRun, Issue } from '../../src/domain/schema.js';
import { computeMetrics } from '../../src/metrics/metrics.js';

// Dynamic import with a COMPUTED specifier: the module does not exist at baseline (that IS
// the red). A static — or even literal dynamic — import of a missing module breaks the
// repo's tsc gate for everyone; a computed specifier is typed `any` and resolved only at
// runtime, inside the gated tests (a top-level await would break baseline suite collection).
async function seam(): Promise<Record<string, unknown>> {
  const spec = '../../src/pipeline/' + 'intervene.js';
  return (await import(spec)) as Record<string, unknown>;
}

const dirs: string[] = [];
function freshStore(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-intv-'));
  dirs.push(root);
  return new Store(root);
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const contract = {
  productGoal: 'g', userStory: 'u', scope: { include: [], exclude: [] },
  acceptanceCriteria: [
    { id: 'AC-Z-1', severity: 'blocker' as const, behavior: 'b', verification: { method: 'unit_test' as const, expected: ['x'] } },
  ],
  redLines: [],
};

function seedIssue(store: Store, id: string, status: string): void {
  store.addIssue(
    Issue.parse({
      id, type: 'harness', title: `t-${id}`, area: 'harness', status,
      assignedAgent: 'claude', contract, createdAt: nowISO(), updatedAt: nowISO(),
    }),
  );
}

/** A driven issue = at least one EvalRun sample (what totals.issuesRun counts). */
function seedRun(store: Store, issueId: string, verdict: 'approve' | 'request_changes'): void {
  store.addEvalRun(
    EvalRun.parse({
      id: `EVAL-${store.db.evalRuns.length + 1}`, issueId, prId: `PR-${issueId}`, attempt: 1,
      sampleIndex: 0, agent: 'claude', verdict, findings: [],
      scores: { functionality: 1, codeQuality: 1, testQuality: 1, ux: 1, accessibility: 1 },
      overall: verdict === 'approve' ? 1 : 0.3, cost: {}, createdAt: nowISO(),
    }),
  );
}

type Recorder = (store: Store, input: { issueId: string; kind: string; reason: string }) => unknown;
const instruments = (store: Store): { perIssue: unknown; rate: unknown } => {
  const m = computeMetrics(store) as unknown as Record<string, unknown>;
  return { perIssue: m.interventionsPerIssue, rate: m.howNonInterventionRate };
};

describe.skipIf(!process.env.ACCEPT_HARNESS)('autonomy-axis instruments — attested HOW-intervention accounting (ISSUE-0011)', () => {
  it('ISSUE-0011/AC-INTV-001 a HOW intervention persists as an attested, auditable fact bound to its issue', async () => {
    const { INTERVENTION_KINDS, recordIntervention } = await seam();
    const kinds = INTERVENTION_KINDS as readonly string[];
    const record = recordIntervention as Recorder;

    // The vocabulary IS the semantic boundary: HOW-involvement only. The ⑥⑦ pattern (a human
    // implementing a gate condition inside a conditional approval) must be expressible…
    const conditional = kinds.find((k) => /conditional/i.test(k));
    expect(conditional).toBeTruthy();
    // …and no judgment point may be (adopt/assign/sign/decide/label are NOT interventions).
    for (const k of kinds) expect(k).not.toMatch(/adopt|assign|\bsign\b|decide|label/i);

    const store = freshStore();
    seedIssue(store, 'ISSUE-A', 'released');
    record(store, { issueId: 'ISSUE-A', kind: conditional!, reason: 'human implemented the wiring pin as a release condition' });

    // Audit from the store alone (ADR-0001): a re-opened store still shows the fact.
    const reopened = new Store(store.root) as unknown as { db: { interventions?: Array<Record<string, unknown>> } };
    const rows = reopened.db.interventions ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.issueId).toBe('ISSUE-A');
    expect(rows[0]!.kind).toBe(conditional);
    expect(rows[0]!.reason).toMatch(/wiring pin/);
    expect(rows[0]!.createdAt).toBeTruthy();
  });

  it('ISSUE-0011/AC-INTV-001 recording rejects loudly: missing reason, out-of-vocabulary kind (incl. judgment points), unknown issue', async () => {
    const { INTERVENTION_KINDS, recordIntervention } = await seam();
    const kinds = INTERVENTION_KINDS as readonly string[];
    const record = recordIntervention as Recorder;
    const kind = kinds[0]!;

    const store = freshStore();
    seedIssue(store, 'ISSUE-A', 'released');

    expect(() => record(store, { issueId: 'ISSUE-A', kind, reason: '' })).toThrow(/reason/i);
    expect(() => record(store, { issueId: 'ISSUE-A', kind: 'decide', reason: 'r' })).toThrow(/kind/i);
    expect(() => record(store, { issueId: 'ISSUE-A', kind: 'adopt', reason: 'r' })).toThrow(/kind/i);
    expect(() => record(store, { issueId: 'ISSUE-NOPE', kind, reason: 'r' })).toThrow(/ISSUE-NOPE/);

    // Loud rejection means NOTHING was persisted either.
    const reopened = new Store(store.root) as unknown as { db: { interventions?: unknown[] } };
    expect(reopened.db.interventions ?? []).toHaveLength(0);
  });

  it('ISSUE-0011/AC-INTV-002 an issue driven to release through judgment points alone counts 0 interventions — fully autonomous', async () => {
    await seam(); // seam must exist for the feature to be graded at all
    const store = freshStore();
    // Released through adopt→assign→drive→decide: judgment points leave NO intervention record.
    seedIssue(store, 'ISSUE-A', 'released');
    seedRun(store, 'ISSUE-A', 'approve');

    const { perIssue, rate } = instruments(store);
    expect(perIssue).toBe(0); // no intervention facts → 0 per driven issue
    expect(rate).toBe(1); // 1/1 driven issues had zero HOW interventions
  });

  it('ISSUE-0011/AC-INTV-003 instruments sit in the machine-readable metrics: per-issue count and non-intervention rate over driven issues; null when nothing was driven', async () => {
    const { INTERVENTION_KINDS, recordIntervention } = await seam();
    const record = recordIntervention as Recorder;
    const kind = (INTERVENTION_KINDS as readonly string[])[0]!;

    // Mixed store: two driven issues, one intervention on one of them.
    const store = freshStore();
    seedIssue(store, 'ISSUE-A', 'released');
    seedRun(store, 'ISSUE-A', 'approve');
    seedIssue(store, 'ISSUE-B', 'released');
    seedRun(store, 'ISSUE-B', 'approve');
    record(store, { issueId: 'ISSUE-B', kind, reason: 'human patched the worktree by hand' });

    const mixed = instruments(store);
    expect(mixed.perIssue).toBeCloseTo(0.5); // 1 intervention / 2 driven issues
    expect(mixed.rate).toBeCloseTo(0.5); // 1 of 2 driven issues intervention-free

    // No driven issues → both null (unobserved is not 0 and not 1 — never-silent).
    const empty = freshStore();
    seedIssue(empty, 'ISSUE-C', 'planned'); // exists but never driven
    const none = instruments(empty);
    expect(none.perIssue).toBeNull();
    expect(none.rate).toBeNull();
  });

  it('ISSUE-0011/AC-INTV-004 retroactive: a released issue accepts intervention records and the instruments recompute (⑥⑦ back-counted)', async () => {
    const { INTERVENTION_KINDS, recordIntervention } = await seam();
    const record = recordIntervention as Recorder;
    const kinds = INTERVENTION_KINDS as readonly string[];
    const conditional = kinds.find((k) => /conditional/i.test(k))!;

    // The ⑥⑦ shape: two issues already released BEFORE the instruments existed.
    const store = freshStore();
    seedIssue(store, 'ISSUE-0007', 'released');
    seedRun(store, 'ISSUE-0007', 'approve');
    seedIssue(store, 'ISSUE-0009', 'released');
    seedRun(store, 'ISSUE-0009', 'approve');
    seedIssue(store, 'ISSUE-X', 'released');
    seedRun(store, 'ISSUE-X', 'approve');

    const before = instruments(store);
    expect(before.rate).toBe(1); // the lie the retroactive records exist to correct

    record(store, { issueId: 'ISSUE-0007', kind: conditional, reason: 'liveness wiring pins implemented by the eval owner inside the gate' });
    record(store, { issueId: 'ISSUE-0009', kind: conditional, reason: 'attempt<=1 boundary pin promoted to the guard by the eval owner' });

    const after = instruments(store);
    expect(after.perIssue).toBeCloseTo(2 / 3);
    expect(after.rate).toBeCloseTo(1 / 3); // only ISSUE-X stayed intervention-free

    // Retroactive records are ordinary auditable facts.
    const reopened = new Store(store.root) as unknown as { db: { interventions?: Array<Record<string, unknown>> } };
    expect((reopened.db.interventions ?? []).map((r) => r.issueId).sort()).toEqual(['ISSUE-0007', 'ISSUE-0009']);
  });
});
