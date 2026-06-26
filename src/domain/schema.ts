/**
 * Machine-readable contracts.
 *
 * These zod schemas ARE the harness's contract language. Everything that crosses
 * an agent boundary — an Issue Contract handed to a Generator, a Scorecard handed
 * back by an Evaluator, a Repair brief — is validated against a schema here. That
 * is the central design bet from the spec: turn "planning / review / QA" into
 * *validatable artifacts* rather than prose, so the loop can be automated, resumed
 * and measured.
 */

import { z } from 'zod';
import { ISSUE_STATUSES } from './states.js';
import { VERIFICATION_METHODS } from '../authoring/lint.js';

// --- small vocabularies ----------------------------------------------------

export const Severity = z.enum(['blocker', 'major', 'minor']);
export type Severity = z.infer<typeof Severity>;

/** How an acceptance criterion is checked. Maps onto a grader (see graders/). */
export const VerificationMethod = z.enum(VERIFICATION_METHODS);
export type VerificationMethod = z.infer<typeof VerificationMethod>;

export const IssueType = z.enum([
  'epic',
  'feature',
  'story',
  'bug',
  'tech-debt',
  'harness', // improvements to this harness itself
  'eval', // improvements to the eval dataset / graders
]);
export type IssueType = z.infer<typeof IssueType>;

export const Area = z.enum(['frontend', 'backend', 'fullstack', 'infra', 'docs', 'eval', 'harness']);
export type Area = z.infer<typeof Area>;

export const IssueStatus = z.enum(ISSUE_STATUSES);

/** Which coding agent backend produced an artifact. */
export const GeneratorAgent = z.enum(['claude', 'codex', 'gemini', 'mock']);
export type GeneratorAgent = z.infer<typeof GeneratorAgent>;

export const AgentRole = z.enum([
  'roadmap-planner',
  'issue-planner',
  'coordinator',
  'generator',
  'evaluator',
  'repair-router',
  'eval-curator',
  'release-manager',
  'harness-analyst',
]);
export type AgentRole = z.infer<typeof AgentRole>;

export const Verdict = z.enum(['approve', 'request_changes', 'needs_human']);
export type Verdict = z.infer<typeof Verdict>;

export const GateResult = z.enum(['pass', 'fail', 'skip']);
export type GateResult = z.infer<typeof GateResult>;

// --- the Issue Contract ----------------------------------------------------

export const AcceptanceCriterion = z.object({
  id: z.string(), // e.g. AC-001
  severity: Severity,
  behavior: z.string(),
  verification: z.object({
    method: VerificationMethod,
    expected: z.array(z.string()).min(1),
  }),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

export const IssueContract = z.object({
  productGoal: z.string(),
  userStory: z.string(),
  scope: z.object({
    include: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default([]),
  }),
  acceptanceCriteria: z.array(AcceptanceCriterion).min(1),
  redLines: z.array(z.string()).default([]),
});
export type IssueContract = z.infer<typeof IssueContract>;

export const Issue = z.object({
  id: z.string(), // ISSUE-0001
  type: IssueType,
  title: z.string(),
  area: Area,
  epicId: z.string().nullable().default(null),
  sprint: z.string().nullable().default(null), // e.g. 2026-W24
  status: IssueStatus.default('planned'),
  assignedAgent: GeneratorAgent.nullable().default(null),
  contract: IssueContract.nullable().default(null), // null until contract-drafted
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Issue = z.infer<typeof Issue>;

export const Epic = z.object({
  id: z.string(), // EPIC-01
  title: z.string(),
  theme: z.string(),
  status: z.enum(['planned', 'in-progress', 'done']).default('planned'),
  issueIds: z.array(z.string()).default([]),
});
export type Epic = z.infer<typeof Epic>;

export const Roadmap = z.object({
  vision: z.string(),
  principles: z.array(z.string()).default([]),
  epicIds: z.array(z.string()).default([]),
});
export type Roadmap = z.infer<typeof Roadmap>;

// --- PR & evaluation -------------------------------------------------------

export const PR = z.object({
  id: z.string(), // PR-0001
  issueId: z.string(),
  branch: z.string(),
  baseBranch: z.string().default('main'),
  generator: GeneratorAgent,
  attempts: z.number().int().nonnegative().default(0), // generation attempts incl. repairs
  status: z.enum(['open', 'changes-requested', 'approved', 'merged']).default('open'),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PR = z.infer<typeof PR>;

export const Finding = z.object({
  criterionId: z.string(),
  severity: Severity,
  expected: z.string(),
  observed: z.string(),
  reproductionSteps: z.array(z.string()).default([]),
  evidence: z.record(z.string()).default({}), // label -> relative path under evidence dir
  requiredFix: z.array(z.string()).default([]),
});
export type Finding = z.infer<typeof Finding>;

export const Scores = z.object({
  functionality: z.number().min(0).max(1),
  codeQuality: z.number().min(0).max(1),
  testQuality: z.number().min(0).max(1),
  ux: z.number().min(0).max(1),
  accessibility: z.number().min(0).max(1),
});
export type Scores = z.infer<typeof Scores>;

export const Cost = z.object({
  usd: z.number().nonnegative().default(0),
  tokens: z.number().nonnegative().default(0),
  seconds: z.number().nonnegative().default(0),
});
export type Cost = z.infer<typeof Cost>;

/**
 * An EvalRun IS the Scorecard, persisted. One row per (PR, attempt). This is the
 * "Eval Result DB" the spec keeps returning to: re-runnable, comparable, the basis
 * for pass@k / pass^k and every dashboard number.
 */
export const EvalRun = z.object({
  id: z.string(), // EVAL-...
  issueId: z.string(),
  prId: z.string(),
  attempt: z.number().int().positive(), // 1-based attempt within this sample
  sampleIndex: z.number().int().nonnegative(), // which independent best-of-N sample
  agent: GeneratorAgent,
  promptVersion: z.string().default('v0'),
  graderVersion: z.string().default('v0'),
  verdict: Verdict,
  hardGates: z.record(GateResult).default({}),
  findings: z.array(Finding).default([]),
  scores: Scores,
  overall: z.number().min(0).max(1),
  evidenceDir: z.string().nullable().default(null),
  cost: Cost,
  featureArea: z.string().default('unknown'),
  // Optional human label, used to compute false-pass / false-fail when present.
  humanVerdict: Verdict.nullable().default(null),
  createdAt: z.string(),
});
export type EvalRun = z.infer<typeof EvalRun>;

/** A row in the Eval Task Registry (lightweight v0). */
export const EvalTask = z.object({
  id: z.string(), // EVAL-TASK-...
  sourceIssueId: z.string().nullable().default(null),
  featureArea: z.string(),
  userGoal: z.string(),
  steps: z.array(z.string()).default([]),
  expected: z.array(z.string()).default([]),
  graders: z.array(VerificationMethod).default([]),
  severity: Severity.default('blocker'),
  createdAt: z.string(),
});
export type EvalTask = z.infer<typeof EvalTask>;

// --- spec authoring (M20 signing) ------------------------------------------

/**
 * The pinned, tamper-evident record a human signature produces (AC-AUTH-007).
 * This is the *version pin*: the signed commit + blob SHAs make the approval
 * auditable, the per-AC fingerprints let drift be detected at AC granularity.
 */
export const ApprovedSpecRef = z.object({
  /** Commit the signature was taken against (`git rev-parse HEAD`). */
  signedCommitSha: z.string(),
  /** Blob gitSha of spec.md at the signed commit (`HEAD:<dir>/spec.md`). */
  specBlobGitSha: z.string(),
  /** Blob gitSha of acceptance.yaml at the signed commit. */
  acceptanceBlobGitSha: z.string(),
  /** AC-ID -> content fingerprint pinned at signing (see authoring/fingerprint.ts). */
  acFingerprints: z.record(z.string()),
  /** Version-pinned system-layer elements referenced (empty on greenfield — not yet seeded). */
  systemRefs: z.array(z.string()).default([]),
  /** AC-IDs this signature covers; status derives from their coverage of the current set. */
  approvedAcIds: z.array(z.string()),
});
export type ApprovedSpecRef = z.infer<typeof ApprovedSpecRef>;

/**
 * The spec state object: the first persistence target for a signature (issues
 * only exist post-decomposition). Identity is the spec dir path. `status` is
 * never stored — it is *derived* from approved.approvedAcIds vs the current AC
 * set (AC-AUTH-008, see authoring/drift.ts deriveStatus).
 */
export const SpecState = z.object({
  path: z.string(), // spec dir, e.g. docs/specs/authoring-layer — the identity
  approved: ApprovedSpecRef.nullable().default(null), // null until first signed
  signedAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SpecState = z.infer<typeof SpecState>;

// --- the whole database ----------------------------------------------------

export const DB = z.object({
  version: z.literal(1).default(1),
  counters: z.record(z.number()).default({}),
  roadmap: Roadmap.nullable().default(null),
  epics: z.array(Epic).default([]),
  issues: z.array(Issue).default([]),
  prs: z.array(PR).default([]),
  evalRuns: z.array(EvalRun).default([]),
  evalTasks: z.array(EvalTask).default([]),
  specStates: z.array(SpecState).default([]),
});
export type DB = z.infer<typeof DB>;

export function emptyDB(): DB {
  return DB.parse({});
}
