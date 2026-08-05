/**
 * The Repair Router: turn an Evaluator's findings into a machine-readable brief the
 * Generator can act on. Blocker findings take priority; if there are none, all
 * findings are forwarded. Each required-fix line becomes an instruction.
 */

import type { EvalRun, Finding, Severity } from '../domain/schema.js';
import type { RepairBrief, PanelRepairBrief, PanelInstruction } from '../domain/artifact.js';

export function buildRepairBrief(run: EvalRun): RepairBrief {
  const currentChange = run.findings.filter(
    (finding) => finding.disposition !== 'separate-issue',
  );
  const blocking = currentChange.filter((f) => f.severity === 'blocker');
  const findings = blocking.length > 0 ? blocking : currentChange;
  const instructions = findings.flatMap((f) =>
    f.requiredFix.length > 0 ? f.requiredFix : [`Resolve ${f.criterionId}`],
  );
  return { fromEvalRunId: run.id, findings, instructions };
}

const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, major: 1, minor: 2 };

/**
 * Turn a panel's perspective runs into one cross-perspective repair brief (ADR-0006 E7 /
 * AC-PANEL-005): blocker-first, one instruction group per DISTINCT finding, each carrying the
 * finding's FULL requiredFix list in order (ISSUE-0004) and tagged with the perspectives that
 * raised it. criterionId is NOT finding identity (ISSUE-0009 / ISSUE-0016): the only collapse
 * is content identity — same criterionId AND same requiredFix list, i.e. several lenses raising
 * the same fix — which merges their perspectives; same-criterion findings with different content
 * all forward. If any perspective has blocker findings, all blocker findings (and only they) are
 * forwarded — the same "fix what blocks first" policy as the single-run brief, generalised
 * across the panel.
 */
export function buildPanelRepairBrief(runs: EvalRun[]): PanelRepairBrief {
  // group every finding by content identity, remembering which perspective(s) raised it
  const byContent = new Map<string, { finding: Finding; perspectives: Set<string> }>();
  for (const run of runs) {
    for (const f of run.findings) {
      if (f.disposition === 'separate-issue') continue;
      const key = JSON.stringify([f.criterionId, f.requiredFix]);
      const entry = byContent.get(key);
      if (entry) {
        // identical content from several lenses: keep the most severe instance, union the lenses
        if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[entry.finding.severity]) entry.finding = f;
        if (run.perspective) entry.perspectives.add(run.perspective);
      } else {
        byContent.set(key, {
          finding: f,
          perspectives: new Set(run.perspective ? [run.perspective] : []),
        });
      }
    }
  }

  const merged = [...byContent.values()];
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
