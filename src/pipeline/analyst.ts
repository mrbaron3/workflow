/**
 * The Harness Analyst reads the metrics and proposes improvements to the *harness*,
 * not the app: low pass^k -> stabilise; low pass@1 -> issues too big / contracts vague;
 * a hot heatmap cell -> add a reviewer/grader or re-route that work to a stronger agent.
 *
 * These become `type:harness` / `type:eval` issues on the same roadmap as feature work,
 * which is the spec's key move: the harness improves itself through the same loop.
 */

import { Issue, type IssueContract, type IssueType } from '../domain/schema.js';
import { Store, nowISO } from '../store/store.js';
import type { Metrics } from '../metrics/metrics.js';

export interface Suggestion {
  type: Extract<IssueType, 'harness' | 'eval'>;
  area: 'harness' | 'eval';
  title: string;
  rationale: string;
  /**
   * Adopt-grade starting point (granularity, handoff frontier): the grounded ③ loop showed
   * threshold-only suggestions sit far from the contract a human actually adopts. A rule
   * that knows its failure class well enough attaches a draft; `createSuggestionIssues`
   * carries it onto the planned issue and `adopt` uses it as the default. The human still
   * confirms the WHAT by adopting — only the sharpening cost drops.
   */
  draftContract?: IssueContract;
}

/**
 * R1's draft: the mechanically-fixable share of the "repair didn't land" class is brief
 * FIDELITY — today buildPanelRepairBrief forwards only requiredFix[0] per criterion, so a
 * multi-step fix reaches the generator truncated. If briefs are already faithful for a
 * given recurrence, the human closes the proposal as investigated instead of adopting.
 */
const REPAIR_BRIEF_FIDELITY_DRAFT: IssueContract = {
  productGoal:
    'Repair briefs forward the FULL fix list: every requiredFix line of a forwarded finding reaches the generator-facing brief, not just the first.',
  userStory:
    'As the harness operator I want the repair router to preserve finding fidelity so a generator can land multi-step fixes in one repair attempt.',
  scope: {
    include: ['src/pipeline/repair.ts', 'src/domain/artifact.ts', 'test/**'],
    exclude: ['test/acceptance-harness/**'],
  },
  acceptanceCriteria: [
    {
      id: 'AC-1',
      severity: 'blocker',
      behavior: 'Every requiredFix line of a forwarded finding appears in the generator-facing RepairBrief.instructions (order preserved within a criterion).',
      verification: { method: 'unit_test', expected: ['a finding with N requiredFix lines yields all N lines in toGenerateBrief(...).instructions'] },
    },
    {
      id: 'AC-2',
      severity: 'blocker',
      behavior: 'Blocker-first forwarding and per-criterion perspective attribution are unchanged, and the whole existing suite stays green.',
      verification: { method: 'unit_test', expected: ['blocker findings suppress non-blockers as before', 'PanelInstruction.perspectives still names every lens that raised the criterion'] },
    },
  ],
  redLines: [
    'Do not modify anything under test/acceptance-harness/** — it is the independent grader.',
    'Keep the blocker-first policy and the PanelRepairBrief attribution intact.',
  ],
};

export function analyzeHarness(store: Store, m: Metrics): Suggestion[] {
  const s: Suggestion[] = [];
  const k = m.headlineK;

  if (m.totals.samples === 0) return s;

  if (m.passHatK < 0.5) {
    s.push({
      type: 'eval',
      area: 'eval',
      title: `Stabilise low pass^${k} (${(m.passHatK * 100).toFixed(0)}%)`,
      rationale:
        `pass^${k} means all ${k} samples pass; it's low, so results are inconsistent. ` +
        `Tighten contracts, reduce nondeterminism in graders, or hold work back from release until pass^${k} rises.`,
    });
  }
  if (m.passAt1 < 0.5) {
    s.push({
      type: 'harness',
      area: 'harness',
      title: `Improve first-attempt success (pass@1 ${(m.passAt1 * 100).toFixed(0)}%)`,
      rationale:
        `Generators rarely pass first try. Issues may be too large or Issue Contracts ambiguous. ` +
        `Split issues smaller and sharpen acceptance criteria in the Issue Contract schema.`,
    });
  }
  if (m.instabilityRate > 0.3) {
    s.push({
      type: 'eval',
      area: 'eval',
      title: `Reduce sample disagreement (instability ${(m.instabilityRate * 100).toFixed(0)}%)`,
      rationale:
        `Many issues have samples that disagree (some pass, some fail). Investigate flaky graders / ` +
        `isolated-environment leaks, or prefer best-of-N + Evaluator selection for these issues.`,
    });
  }
  if (m.repairSuccessRate < 0.6) {
    s.push({
      type: 'harness',
      area: 'harness',
      title: `Make repair briefs more actionable (repair success ${(m.repairSuccessRate * 100).toFixed(0)}%)`,
      rationale:
        `Generators often fail to recover from Evaluator feedback. Improve the Repair Router to emit ` +
        `more concrete required-fix steps with evidence pointers.`,
    });
  }
  if (m.falsePassRate === null) {
    s.push({
      type: 'eval',
      area: 'eval',
      title: 'Build a human-labelled calibration set',
      rationale:
        `No EvalRuns carry a human verdict, so false-pass / false-fail and grader agreement can't be ` +
        `measured. Label ~20 runs with \`agentops label\` to start calibrating the graders.`,
    });
  }

  // --- failure-class rules (granularity): specifics from the store, not thresholds -----

  // R1: a criterion whose finding recurs in CONSECUTIVE attempts of the same PR — the
  // repair brief demonstrably did not land. Cites the survivors; drafts the fidelity fix.
  const byPr = new Map<string, Map<number, Set<string>>>();
  for (const r of store.db.evalRuns) {
    const attempts = byPr.get(r.prId) ?? new Map<number, Set<string>>();
    const crits = attempts.get(r.attempt) ?? new Set<string>();
    for (const f of r.findings) crits.add(f.criterionId);
    attempts.set(r.attempt, crits);
    byPr.set(r.prId, attempts);
  }
  const survivors: string[] = [];
  for (const [prId, attempts] of byPr) {
    for (const [attempt, crits] of attempts) {
      const next = attempts.get(attempt + 1);
      if (!next) continue;
      for (const c of crits) {
        if (next.has(c)) {
          const issueId = store.db.evalRuns.find((r) => r.prId === prId)?.issueId ?? prId;
          survivors.push(`${issueId} ${c} (attempt ${attempt}→${attempt + 1})`);
        }
      }
    }
  }
  if (survivors.length) {
    s.push({
      type: 'harness',
      area: 'harness',
      title: `Repair briefs failed to land: ${survivors.length} finding(s) survived a repair attempt`,
      rationale:
        `The same criterion was flagged again AFTER a repair attempt: ${survivors.join('; ')}. ` +
        `The mechanically-fixable share of this class is brief fidelity (today only requiredFix[0] per ` +
        `criterion reaches the generator) — the attached draft contract targets it; if briefs are already ` +
        `faithful here, close this as investigated.`,
      draftContract: REPAIR_BRIEF_FIDELITY_DRAFT,
    });
  }

  // R2: the same hard gate failing repeatedly across runs — a systematic seam problem
  // (e.g. recurring scope_check = contracts whose scope forbids what the briefs demand).
  const gateHits = new Map<string, Set<string>>(); // gate -> issue ids
  for (const r of store.db.evalRuns) {
    for (const f of r.findings) {
      if (!f.criterionId.startsWith('GATE-')) continue;
      const gate = f.criterionId.slice(5);
      const issues = gateHits.get(gate) ?? new Set<string>();
      issues.add(r.issueId);
      gateHits.set(gate, issues);
    }
  }
  for (const [gate, issueIds] of gateHits) {
    const count = store.db.evalRuns.reduce(
      (n, r) => n + r.findings.filter((f) => f.criterionId === `GATE-${gate}`).length, 0);
    if (count < 2) continue;
    s.push({
      type: 'harness',
      area: 'harness',
      title: `Recurring ${gate} gate failures (${count}×)`,
      rationale:
        `The ${gate} gate failed ${count} times across ${issueIds.size} issue(s): ${[...issueIds].sort().join(', ')}. ` +
        `A repeating gate is a seam problem, not an agent problem — add a contract lint / pre-flight check ` +
        `that catches this class before a generator session is ever spent on it.`,
    });
  }

  // R3: registry hygiene — captured failures that CANNOT currently be re-verified.
  const latest = new Map<string, string>(); // taskId -> latest result
  for (const r of store.db.regressionRuns) latest.set(r.taskId, r.result);
  const unbound = store.db.evalTasks.filter((t) => t.target === null).map((t) => t.id);
  const unverified = store.db.evalTasks.filter((t) => latest.get(t.id) === 'unverified').map((t) => t.id);
  if (unbound.length || unverified.length) {
    s.push({
      type: 'eval',
      area: 'eval',
      title: `Regression registry hygiene: ${unbound.length} unbound, ${unverified.length} unverified task(s)`,
      rationale:
        (unbound.length ? `Unbound (no target — re-curate under a config to bind): ${unbound.join(', ')}. ` : '') +
        (unverified.length ? `Unverified (no assertion carries their AC id — tag tests or refine the tasks): ${unverified.join(', ')}. ` : '') +
        `Until fixed these captured failures cannot be re-verified, so the steering star's second half is blind there.`,
    });
  }

  // hottest heatmap cell -> targeted suggestion
  let hot: { area: string; type: string; n: number } | null = null;
  for (const area of m.heatmap.areas) {
    for (const t of m.heatmap.types) {
      const n = m.heatmap.counts[area]?.[t] ?? 0;
      if (!hot || n > hot.n) hot = { area, type: t, n };
    }
  }
  if (hot && hot.n > 0) {
    s.push({
      type: 'harness',
      area: 'harness',
      title: `Address top failure: ${hot.area} × ${hot.type} (${hot.n} hits)`,
      rationale:
        `This is the most common blocking failure. Add a dedicated reviewer/grader for ${hot.type} on ` +
        `${hot.area} work, or add a routing rule to send ${hot.area} issues to a stronger agent for ${hot.type}.`,
    });
  }

  return s;
}

/** Optionally turn suggestions into real backlog issues (status: planned). */
export function createSuggestionIssues(store: Store, suggestions: Suggestion[]): Issue[] {
  const created: Issue[] = [];
  for (const sug of suggestions) {
    // de-dupe by title
    if (store.db.issues.some((i) => i.title === sug.title)) continue;
    const issue = Issue.parse({
      id: store.nextId('ISSUE'),
      type: sug.type,
      title: sug.title,
      area: sug.area,
      epicId: null,
      sprint: null,
      status: 'planned', // a draft contract does NOT make it drivable — adopt is the confirmation
      assignedAgent: null,
      contract: sug.draftContract ?? null,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    });
    store.addIssue(issue);
    created.push(issue);
  }
  return created;
}
