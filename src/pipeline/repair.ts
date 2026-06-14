/**
 * The Repair Router: turn an Evaluator's findings into a machine-readable brief the
 * Generator can act on. Blocker findings take priority; if there are none, all
 * findings are forwarded. Each required-fix line becomes an instruction.
 */

import type { EvalRun } from '../domain/schema.js';
import type { RepairBrief } from '../domain/artifact.js';

export function buildRepairBrief(run: EvalRun): RepairBrief {
  const blocking = run.findings.filter((f) => f.severity === 'blocker');
  const findings = blocking.length > 0 ? blocking : run.findings;
  const instructions = findings.flatMap((f) =>
    f.requiredFix.length > 0 ? f.requiredFix : [`Resolve ${f.criterionId}`],
  );
  return { fromEvalRunId: run.id, findings, instructions };
}
