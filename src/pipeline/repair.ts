/**
 * The Repair Router: turn an Evaluator's findings into a machine-readable brief the
 * Generator can act on. Blocker findings take priority; if there are none, all
 * findings are forwarded. Each required-fix line becomes an instruction.
 */

import type { EvalRun, Finding, Severity } from '../domain/schema.js';
import type { RepairBrief, PanelRepairBrief, PanelInstruction } from '../domain/artifact.js';

export function buildRepairBrief(run: EvalRun): RepairBrief {
  const blocking = run.findings.filter((f) => f.severity === 'blocker');
  const findings = blocking.length > 0 ? blocking : run.findings;
  const instructions = findings.flatMap((f) =>
    f.requiredFix.length > 0 ? f.requiredFix : [`Resolve ${f.criterionId}`],
  );
  return { fromEvalRunId: run.id, findings, instructions };
}

const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, major: 1, minor: 2 };

/**
 * Turn a panel's perspective runs into one cross-perspective repair brief (ADR-0006 E7 /
 * AC-PANEL-005): blocker-first, one instruction per criterion (a criterion flagged by several
 * perspectives is merged), each carrying the forwarded finding's FULL requiredFix list in order
 * (ISSUE-0004) and tagged with the perspectives that raised it. If any perspective has blocker
 * findings, only blockers are forwarded — the same "fix what blocks first" policy as the
 * single-run brief, generalised across the panel.
 */
export function buildPanelRepairBrief(runs: EvalRun[]): PanelRepairBrief {
  // group every finding by criterion, remembering which perspective(s) raised it
  const byCriterion = new Map<string, { finding: Finding; perspectives: Set<string> }>();
  for (const run of runs) {
    for (const f of run.findings) {
      const entry = byCriterion.get(f.criterionId);
      if (entry) {
        // keep the most severe instance; accumulate the perspectives
        if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[entry.finding.severity]) entry.finding = f;
        if (run.perspective) entry.perspectives.add(run.perspective);
      } else {
        byCriterion.set(f.criterionId, {
          finding: f,
          perspectives: new Set(run.perspective ? [run.perspective] : []),
        });
      }
    }
  }

  const merged = [...byCriterion.values()];
  const anyBlocker = merged.some((m) => m.finding.severity === 'blocker');
  const forwarded = anyBlocker ? merged.filter((m) => m.finding.severity === 'blocker') : merged;
  forwarded.sort((a, b) => SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity]);

  const instructions: PanelInstruction[] = forwarded.map((m) => ({
    criterionId: m.finding.criterionId,
    severity: m.finding.severity,
    instructions:
      m.finding.requiredFix.length > 0 ? [...m.finding.requiredFix] : [`Resolve ${m.finding.criterionId}`],
    perspectives: [...m.perspectives].sort(),
  }));

  return {
    fromEvalRunIds: runs.map((r) => r.id),
    instructions,
    findings: forwarded.map((m) => m.finding),
  };
}

/**
 * Adapt a cross-perspective panel brief to the single RepairBrief the Generator seam consumes.
 * The perspective tags are dropped here (the generator acts on the instructions, not on who
 * raised them); the attribution is preserved on the PanelRepairBrief for the improvement loop.
 */
export function toGenerateBrief(panel: PanelRepairBrief): RepairBrief {
  return {
    fromEvalRunId: panel.fromEvalRunIds[0] ?? '',
    findings: panel.findings,
    instructions: panel.instructions.flatMap((i) => i.instructions),
  };
}
