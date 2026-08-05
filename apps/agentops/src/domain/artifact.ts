/**
 * The artifact a Generator produces and a Grader inspects.
 *
 * In a real deployment this would be an actual git branch + diff, and graders would
 * run real commands (npm test, playwright, etc.) against a checkout. Here it is a
 * structured *description* of what was built, so the whole loop runs offline and
 * deterministically. The shape is the contract between generator and grader — keep
 * it stable even as backends change.
 */

import type { Finding, IssueContract, Issue, VerificationMethod } from './schema.js';

export interface VerificationEvidence {
  method: VerificationMethod;
  /** Exact configured command; null means no executor was configured and the AC failed closed. */
  command: string | null;
  passed: boolean;
  /** Bounded command/report output retained with the build evidence. */
  output: string;
}

export interface BuildArtifact {
  branch: string;
  summary: string;
  filesChanged: string[];
  /** Acceptance-criterion id -> was it satisfied by this build? */
  satisfied: Record<string, boolean>;
  /** Grounded per-criterion execution evidence. Optional for legacy/mock artifacts. */
  verificationEvidence?: Record<string, VerificationEvidence>;
  // hard-gate facts
  buildPasses: boolean;
  typecheckPasses: boolean;
  unitTestsPass: boolean;
  apiTestsPass: boolean;
  hasTests: boolean;
  /**
   * Isolated runner only: whether the built checkout still exposes exactly the
   * bounded repository grader profile captured before untrusted generation.
   * Undefined keeps legacy/non-runner artifacts additive.
   */
  graderProfileValid?: boolean;
  /** Bounded repair evidence when graderProfileValid is false. */
  graderProfileError?: string;
  secretsLeaked: boolean;
  /** Files touched outside the contract's declared scope (AI-antipattern: scope creep). */
  scopeViolations: string[];
  /** Qualitative signals (0..1) read by the rubric/LLM grader. */
  quality: {
    codeQuality: number;
    testQuality: number;
    ux: number;
    accessibility: number;
  };
  notes: string[];
}

/** A repair brief, produced by the Repair Router from an EvalRun's findings. */
export interface RepairBrief {
  fromEvalRunId: string;
  findings: Finding[];
  instructions: string[];
}

/**
 * One repair instruction that carries which review perspective(s) raised it — so the
 * Generator knows whose objection it is answering, and the improvement loop can later
 * attribute a fix to the perspective that demanded it (ADR-0006 E7 / AC-PANEL-005).
 */
export interface PanelInstruction {
  criterionId: string;
  severity: Finding['severity'];
  /** Every requiredFix line of the forwarded finding, order preserved (ISSUE-0004). */
  instructions: string[];
  /**
   * Perspectives that raised this finding. One entry per DISTINCT finding (ISSUE-0016):
   * only content-identical findings (same criterionId + requiredFix list) merge, unioning
   * their perspectives — same-criterion findings with different content stay separate.
   */
  perspectives: string[];
}

/** Cross-perspective repair brief: every distinct finding from every perspective run, blocker-first. */
export interface PanelRepairBrief {
  fromEvalRunIds: string[];
  instructions: PanelInstruction[];
  findings: Finding[];
}

export interface GenerateInput {
  issue: Issue;
  contract: IssueContract;
  /** Which independent best-of-N sample this is (0-based). */
  sampleIndex: number;
  /** 1-based attempt within the sample (attempt 1 = fresh, 2+ = repair). */
  attempt: number;
  /** Present on repair attempts. */
  repairBrief?: RepairBrief | null;
}
