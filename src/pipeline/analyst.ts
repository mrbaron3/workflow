/**
 * The Harness Analyst reads the metrics and proposes improvements to the *harness*,
 * not the app: low pass^k -> stabilise; low pass@1 -> issues too big / contracts vague;
 * a hot heatmap cell -> add a reviewer/grader or re-route that work to a stronger agent.
 *
 * These become `type:harness` / `type:eval` issues on the same roadmap as feature work,
 * which is the spec's key move: the harness improves itself through the same loop.
 */

import { Issue, type IssueType } from '../domain/schema.js';
import { Store, nowISO } from '../store/store.js';
import type { Metrics } from '../metrics/metrics.js';

export interface Suggestion {
  type: Extract<IssueType, 'harness' | 'eval'>;
  area: 'harness' | 'eval';
  title: string;
  rationale: string;
}

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
      status: 'planned',
      assignedAgent: null,
      contract: null,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    });
    store.addIssue(issue);
    created.push(issue);
  }
  return created;
}
