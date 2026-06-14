/**
 * The artifact a Generator produces and a Grader inspects.
 *
 * In a real deployment this would be an actual git branch + diff, and graders would
 * run real commands (npm test, playwright, etc.) against a checkout. Here it is a
 * structured *description* of what was built, so the whole loop runs offline and
 * deterministically. The shape is the contract between generator and grader — keep
 * it stable even as backends change.
 */

import type { Finding, IssueContract, Issue } from './schema.js';

export interface BuildArtifact {
  branch: string;
  summary: string;
  filesChanged: string[];
  /** Acceptance-criterion id -> was it satisfied by this build? */
  satisfied: Record<string, boolean>;
  // hard-gate facts
  buildPasses: boolean;
  typecheckPasses: boolean;
  unitTestsPass: boolean;
  apiTestsPass: boolean;
  hasTests: boolean;
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
