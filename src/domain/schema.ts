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
import {
  AgentProvider,
  GeneratorAgent,
  InvocationOutcome,
  InvocationRole,
  Verdict,
} from './agent-runtime.js';
import { NullableRevisionCoordinates, PR, PrRevision, RevisionGateSnapshot } from './pr-schema.js';
export * from './agent-runtime.js';
export * from './pr-schema.js';
export * from './revision-gate.js';
export * from './pr-lifecycle.js';

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

/** Dedicated UI-authoring artifact; HOW design is explicit and traceable to the accepted WHAT. */
export const UiDesignToken = z.object({
  id: z.string().min(1),
  category: z.enum(['color', 'typography', 'spacing', 'radius', 'shadow', 'motion', 'other']),
  value: z.string().min(1),
  rationale: z.string().min(1),
  sourceCriterionIds: z.array(z.string().min(1)).min(1),
});
export type UiDesignToken = z.infer<typeof UiDesignToken>;

export const UiDesignComponent = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  purpose: z.string().min(1),
  states: z.array(z.string().min(1)).min(1),
  interactions: z.array(z.string().min(1)).default([]),
  accessibility: z.array(z.string().min(1)).min(1),
  sourceCriterionIds: z.array(z.string().min(1)).min(1),
});
export type UiDesignComponent = z.infer<typeof UiDesignComponent>;

export const UiDesignArtifact = z.object({
  candidateKey: z.string().min(1),
  principles: z.array(z.string().min(1)).min(1),
  tokens: z.array(UiDesignToken).min(1),
  components: z.array(UiDesignComponent).min(1),
  criterionTraces: z.array(z.object({
    criterionId: z.string().min(1),
    designElementIds: z.array(z.string().min(1)).min(1),
  })).min(1),
});
export type UiDesignArtifact = z.infer<typeof UiDesignArtifact>;

export const UiDesignOutput = z.object({
  artifact: UiDesignArtifact.nullable(),
  ambiguities: z.array(z.string().min(1)).default([]),
});
export type UiDesignOutput = z.infer<typeof UiDesignOutput>;

export const Issue = z.object({
  id: z.string(), // ISSUE-0001
  type: IssueType,
  title: z.string(),
  area: Area,
  epicId: z.string().nullable().default(null),
  // Planning-tree links (DOC_TAXONOMY §2本の木): which feature/spec this issue descends from,
  // so north-star → feature → AC → issue → PR is mechanically traceable.
  featureId: z.string().nullable().default(null), // FEAT-NNN this issue serves (null for non-spec work)
  specPath: z.string().nullable().default(null), // signed spec dir this issue decomposes — the coverage-set key
  sprint: z.string().nullable().default(null), // e.g. 2026-W24
  status: IssueStatus.default('planned'),
  assignedAgent: GeneratorAgent.nullable().default(null),
  contract: IssueContract.nullable().default(null), // null until contract-drafted
  // Nano decomposition (to-detail-design; replaces the old slice .md — DOC_TAXONOMY §NANO).
  // coversAcIds is the 被覆×排他 unit: every spec AC must be covered by exactly one issue in the set.
  coversAcIds: z.array(z.string()).default([]), // spec AC-IDs this issue satisfies
  // File-scope boundary from to-detail-design (issues.yaml `scope:`): the glob sets the drafted
  // contract's scope_check enforces against CHANGED FILES. null = undeclared → the contract
  // drafts unrestricted (include=[]). Never AC ids — an AC id is not a glob and matches no file.
  scope: z
    .object({
      include: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
    })
    .nullable()
    .default(null),
  dependsOnSystem: z.array(z.string()).default([]), // system element ids referenced (DOM/DATA/ARCH/…-<CTX>-NNN) — referenced, never copied
  dependsOnIssues: z.array(z.string()).default([]), // predecessor issues, forming the spec's issue DAG
  implementationNotes: z.array(z.string()).default([]), // seam-level HOW hints (optional; internal, not a contract)
  /** GitHub intake origin (FEAT-017). null for spec/adopt/legacy issues. */
  intakeKey: z.string().nullable().default(null),
  planningCandidateKey: z.string().nullable().default(null),
  uiDesign: UiDesignArtifact.nullable().default(null),
  uiDesignInvocationKey: z.string().nullable().default(null),
  /**
   * Decline audit (FEAT-005): why/when a human closed this issue. Set ONLY by the decline
   * organ (pipeline/lifecycle.ts closeIssue — a judgment point, never automated); null on
   * every non-closed issue. Additive — absent on older records.
   */
  closedReason: z.string().nullable().default(null),
  closedAt: z.string().nullable().default(null),
  /**
   * Which Analyst diagnostic rule filed this proposal (FEAT-005). The rule — not the title
   * text, which bakes in moving metric values — is the dedup identity: at most one OPEN
   * proposal per rule, while a terminal (closed/released) one never suppresses re-filing.
   * null = not rule-filed (spec-spawned or hand-created). Additive.
   */
  sourceRuleId: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Issue = z.infer<typeof Issue>;

export const Epic = z.object({
  id: z.string(), // EPIC-01
  title: z.string(),
  theme: z.string(),
  status: z.enum(['planned', 'in-progress', 'done']).default('planned'),
  featureIds: z.array(z.string()).default([]), // ordered features under this epic (bidirectional: Feature.epicId)
  issueIds: z.array(z.string()).default([]),
});
export type Epic = z.infer<typeof Epic>;

export const Roadmap = z.object({
  vision: z.string(),
  principles: z.array(z.string()).default([]),
  epicIds: z.array(z.string()).default([]),
});
export type Roadmap = z.infer<typeof Roadmap>;

export const FeatureStatus = z.enum(['planned', 'specced', 'signed', 'implemented']);
export type FeatureStatus = z.infer<typeof FeatureStatus>;

/**
 * A leaf of the planning tree (DOC_TAXONOMY §2本の木): one signable capability.
 * roadmap-planner emits only the outcome + order — never acceptance criteria (those are
 * authored into the signed spec by to-spec). `specPath` is the 交点 where the planning
 * tree meets the system tree: one Feature becomes exactly one signed spec (AC-PLAN-003/004).
 * Descoping a feature flips `inPlan`, it never deletes a signed spec (AC-PLAN-009).
 */
export const Feature = z.object({
  id: z.string(), // FEAT-NNN
  epicId: z.string().nullable().default(null), // parent epic (bidirectional: Epic.featureIds)
  title: z.string(),
  outcome: z.string(), // the capability/value ("why now") — no acceptance criteria here
  specPath: z.string().nullable().default(null), // signed spec dir once spawned (bidirectional: SpecState.featureId)
  status: FeatureStatus.default('planned'),
  inPlan: z.boolean().default(true), // false = descoped: a flag, never a deletion (AC-PLAN-009)
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Feature = z.infer<typeof Feature>;

// --- Intake & evaluation ---------------------------------------------------

/** Immutable first-seen projection of one external GitHub Issue (FEAT-016). */
export const GithubIssueSnapshot = z.object({
  repository: z.string().min(1), // owner/name remote identity
  number: z.number().int().positive(),
  externalId: z.string().min(1),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  labels: z.array(z.string()).default([]),
  state: z.enum(['open', 'closed']),
  sourceUpdatedAt: z.string(),
  snapshotAt: z.string(),
});
export type GithubIssueSnapshot = z.infer<typeof GithubIssueSnapshot>;

export const IntakeStatus = z.enum([
  'claim-pending',
  'claimed',
  'planning',
  'ready',
  'needs-human-review',
]);
export type IntakeStatus = z.infer<typeof IntakeStatus>;

/** Store-first claim record; the Source Snapshot is immutable after insertion. */
export const IntakeRecord = z.object({
  id: z.string(), // INTAKE-0001
  intakeKey: z.string().min(1),
  provider: z.literal('github'),
  snapshot: GithubIssueSnapshot,
  status: IntakeStatus.default('claim-pending'),
  claimedAt: z.string().nullable().default(null),
  storeIssueIds: z.array(z.string()).default([]),
  /** Split-source aggregation close result (single-child sources use the PR's Closes relation). */
  sourceClosedAt: z.string().nullable().default(null),
  sourceCloseError: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IntakeRecord = z.infer<typeof IntakeRecord>;

export const AcceptanceTraceSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source'), text: z.string().min(1) }),
  z.object({
    kind: z.literal('system'),
    elementId: z.string().regex(/^(?:LANG|DOM|ARCH|DATA)-[a-z0-9]+(?:-[a-z0-9]+)*-\d{3}$/),
  }),
]);
export type AcceptanceTraceSource = z.infer<typeof AcceptanceTraceSource>;

export const AcceptanceTrace = z.object({
  criterionId: z.string().min(1),
  sources: z.array(AcceptanceTraceSource).min(1),
});
export type AcceptanceTrace = z.infer<typeof AcceptanceTrace>;

export const EnrichmentCandidate = z.object({
  candidateKey: z.string().min(1),
  title: z.string().min(1),
  type: IssueType,
  area: Area,
  contract: IssueContract,
  traces: z.array(AcceptanceTrace),
});
export type EnrichmentCandidate = z.infer<typeof EnrichmentCandidate>;

export const PlanningEnrichmentOutput = z.object({
  candidates: z.array(EnrichmentCandidate).min(1),
  ambiguities: z.array(z.string().min(1)).default([]),
});
export type PlanningEnrichmentOutput = z.infer<typeof PlanningEnrichmentOutput>;

export const PlanningEnrichmentRecord = z.object({
  id: z.string(), // ENRICH-0001
  intakeKey: z.string().min(1),
  invocationKey: z.string().nullable().default(null),
  status: z.enum(['accepted', 'needs-human-review']),
  reasons: z.array(z.string()).default([]),
  traces: z.array(
    z.object({
      candidateKey: z.string(),
      criterionId: z.string(),
      sources: z.array(AcceptanceTraceSource),
    }),
  ).default([]),
  issueIds: z.array(z.string()).default([]),
  uiDesignCandidateKeys: z.array(z.string()).default([]),
  uiDesignInvocationKeys: z.record(z.string()).default({}),
  createdAt: z.string(),
});
export type PlanningEnrichmentRecord = z.infer<typeof PlanningEnrichmentRecord>;

/**
 * ISSUE-0009: on a re-review (attempt > 1) the reviewer ATTESTS each finding's lineage —
 * 'persisted' = the same problem survived the repair, 'new' = first seen this review.
 * Optional/additive: absent = legacy record, deliberately indeterminate (never defaulted
 * to either value — the Analyst must not guess).
 */
export const FindingLineage = z.enum(['persisted', 'new']);
export type FindingLineage = z.infer<typeof FindingLineage>;

export const Finding = z.object({
  criterionId: z.string(),
  severity: Severity,
  expected: z.string(),
  observed: z.string(),
  reproductionSteps: z.array(z.string()).default([]),
  evidence: z.record(z.string()).default({}), // label -> relative path under evidence dir
  requiredFix: z.array(z.string()).default([]),
  lineage: FindingLineage.optional(),
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
const EvalRunRecord = z.object({
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
  // DATA-execution-001: which review perspective (lens) produced this run when graded by
  // the evaluator panel; null = legacy single composite grade. Additive/optional.
  perspective: z.string().nullable().default(null),
  // DATA-agent-runtime-004: reviewer invocation that produced this perspective verdict.
  // null = legacy, deterministic grader, or pre-provenance run.
  invocationKey: z.string().nullable().default(null),
  createdAt: z.string(),
});
// ADR-0009: null only for legacy pre-PR-revision scorecards. The union keeps
// revisionId and headSha correlated in both the runtime schema and inferred type.
export const EvalRun = EvalRunRecord.and(NullableRevisionCoordinates);
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
  /**
   * Which target repo this task's graders bind to (config.target.repo at curation time).
   * The registry can mix tasks from different targets (sandbox vs self-hosted) and AC ids
   * collide across issues, so the regression executor only runs tasks bound to the CURRENT
   * target. null = legacy/unbound: skipped and reported, never guessed. Additive.
   */
  target: z.string().nullable().default(null),
  /**
   * Grader commands captured at curation time, keyed by VERIFICATION METHOD (e.g.
   * 'unit_test' → the runnable command from config.target.graders). The task carries its
   * own means of execution, so repointing config.target at another repo later cannot
   * orphan it. Only methods with a configured command are captured — never fabricated.
   * null = legacy/uncaptured: runnable only via the config fallback when bound to the
   * current target. Additive.
   */
  graderCommands: z.record(z.string()).nullable().default(null),
  /**
   * Retirement audit (FEAT-005): why/when a human retired this task from execution. Set
   * ONLY by pipeline/lifecycle.ts retireEvalTask (a judgment point, never automated).
   * Retirement is a STATE, not an erasure: the record stays (capture history — and
   * regressionCaptureRate — are untouched); only execution and the executed/unverified
   * accounting exclude a retired task. null = active. Additive — absent on older records.
   */
  retiredReason: z.string().nullable().default(null),
  retiredAt: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type EvalTask = z.infer<typeof EvalTask>;

/**
 * One execution of a regression EvalTask against its target's real graders — the second
 * half of the steering star ("never repeat the same failure twice"): captured failures are
 * re-verified, durably (ADR-0001). Kept SEPARATE from EvalRun on purpose: EvalRuns are the
 * per-(PR, attempt) scorecards that pass@k / pass^k count over; regression executions must
 * not inflate those denominators. `unverified` = the task's AC id matched no assertion in
 * the report — surfaced, never treated as a pass (never-silent).
 */
export const RegressionRun = z.object({
  id: z.string(), // REGRUN-...
  taskId: z.string(), // EVAL-TASK-... this executed
  target: z.string(), // repo the graders ran against
  result: z.enum(['pass', 'fail', 'unverified']),
  matchedAssertions: z.number().int().nonnegative().default(0),
  failedNames: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type RegressionRun = z.infer<typeof RegressionRun>;

/**
 * The exact prompt text issued to a role session, preserved for audit (DATA-execution-006).
 * A Session is volatile by design (DOM-execution-002): its `.agentops/PROMPT.md` is OVERWRITTEN in
 * place on each repair attempt and lives only under the gitignored, wiped `.harness/` worktree — so
 * without this the text of attempt 1 (and how the repair brief reshaped attempt 2) is lost. This is
 * an additive AUDIT projection: it does not change the Session's runtime volatility, it copies the
 * issued prompt into the store (the single inspectable SoT). One row per (issue, sample, attempt,
 * role). `perspective` names the lens for a reviewer prompt (null for the generator); `model` is the
 * resolved `--model` for that session (null = the user's default model); `outcome` is the session's
 * liveness result so a stuck attempt — which produces no EvalRun — still leaves a durable trace.
 */
export const PromptRecord = z.object({
  id: z.string(), // PROMPT-0001
  issueId: z.string(),
  prId: z.string(),
  sampleIndex: z.number().int().nonnegative(),
  attempt: z.number().int().positive(), // 1-based; > 1 carries the repair brief
  role: z.enum(['generator', 'reviewer']).default('generator'),
  perspective: z.string().nullable().default(null), // reviewer lens; null for the generator
  agent: GeneratorAgent,
  model: z.string().nullable().default(null), // resolved --model; null = user default
  outcome: z.string().nullable().default(null), // completed | stuck | timeout; null = not captured
  prompt: z.string(),
  createdAt: z.string(),
});
export type PromptRecord = z.infer<typeof PromptRecord>;

/**
 * Provider-neutral audit record for one logical role session (FEAT-013). Unlike the legacy
 * generator-only PromptRecord, this records generator, planning and each reviewer perspective
 * through one identity and keeps provider separate from model.
 */
const AgentInvocationRecord = z.object({
  id: z.string(), // INVOKE-0001
  invocationKey: z.string().min(1),
  subjectId: z.string().min(1),
  issueId: z.string().nullable().default(null),
  prId: z.string().nullable().default(null),
  sampleIndex: z.number().int().nonnegative().nullable().default(null),
  attempt: z.number().int().positive(),
  role: InvocationRole,
  perspective: z.string().nullable().default(null),
  provider: AgentProvider,
  model: z.string().nullable().default(null),
  prompt: z.string(),
  outcome: InvocationOutcome,
  createdAt: z.string(),
});
export const AgentInvocation =
  AgentInvocationRecord.and(NullableRevisionCoordinates);
export type AgentInvocation = z.infer<typeof AgentInvocation>;

/**
 * The concurrency FACTS of one live turn (ISSUE-0020, AC-PAR-003): how many issues the
 * turn drove, the effective cap it ran under, and the peak simultaneous in-flight count
 * OBSERVED at the dispatch seam (not reconstructed from logs — never log-only, ADR-0001).
 * Appended once per completed live turn; metrics surface the LATEST record as the turn
 * instruments, and null-when-absent keeps "unobserved" distinct from "observed 0".
 */
export const TurnRecord = z.object({
  id: z.string(), // TURN-0001
  cap: z.number().int().positive(), // effective cap (resolveConcurrentIssueCap) for the turn
  issuesDriven: z.number().int().nonnegative(), // queued issues the turn dispatched
  peakConcurrency: z.number().int().nonnegative(), // max simultaneous in-flight observed
  createdAt: z.string(),
});
export type TurnRecord = z.infer<typeof TurnRecord>;

// --- human HOW-interventions (autonomy axis, ISSUE-0011) --------------------

/**
 * The attested HOW-involvement vocabulary. The WHAT/HOW boundary from the spec
 * (docs/specs/autonomy-axis-instruments-human-how-intervention-accounting) is baked into
 * the vocabulary itself: human JUDGMENT POINTS (adopt / assign / sign / decide / label)
 * are part of the autonomy definition, not interventions — no kind exists for them, so
 * miscounting a judgment as an intervention is structurally impossible.
 */
export const INTERVENTION_KINDS = [
  'conditional-approval-implementation', // ⑥⑦: human implements a gate/release condition inside a conditional approval
  'workspace-hand-edit', // human edits an agent's worktree or artifact by hand
  'repair-brief-hand-edit', // human authors or augments a repair brief
  'manual-evidence-collection', // ⑤: human collects evidence the harness should have produced
] as const;
export const InterventionKind = z.enum(INTERVENTION_KINDS);
export type InterventionKind = z.infer<typeof InterventionKind>;

/**
 * One attested human HOW-intervention, bound to an issue. Only explicit records are
 * intervention facts — nothing may infer one from other store state (⑦'s lesson: a
 * guessing diagnostician produces false positives/negatives). `createdAt` is the RECORD
 * time: retroactive records on released issues are ordinary facts (AC-INTV-004).
 */
export const Intervention = z.object({
  id: z.string(), // INTV-0001
  issueId: z.string(),
  kind: InterventionKind,
  reason: z.string().min(1),
  createdAt: z.string(),
});
export type Intervention = z.infer<typeof Intervention>;

// --- spec authoring (M20 signing) ------------------------------------------

/**
 * The pinned, tamper-evident record a human signature produces (AC-AUTH-007).
 * This is the *version pin*: the signed commit + blob SHAs make the approval
 * auditable, the per-AC fingerprints let drift be detected at AC granularity.
 */
export const ApprovedSpecRef = z.object({
  /** Commit the signature was taken against (`git rev-parse HEAD`). */
  signedCommitSha: z.string(),
  /** Blob gitSha of the requirement doc (requirements.md; legacy spec.md) at the signed commit. */
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
  featureId: z.string().nullable().default(null), // planning-tree feature this spec realizes (bidirectional: Feature.specPath)
  approved: ApprovedSpecRef.nullable().default(null), // null until first signed
  signedAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SpecState = z.infer<typeof SpecState>;

// --- the whole database ----------------------------------------------------

/**
 * Durable one-store/one-target binding (DATA-workspace-001). The configured target is only
 * a request; this record is the source of truth that prevents one organisation store from
 * ingesting two unrelated planning trees after config.target changes.
 */
export const TargetBinding = z.object({
  targetIdentity: z.string().min(1),
  boundAt: z.string(),
});
export type TargetBinding = z.infer<typeof TargetBinding>;

export const DB = z.object({
  version: z.literal(1).default(1),
  targetBinding: TargetBinding.nullable().default(null),
  counters: z.record(z.number()).default({}),
  roadmap: Roadmap.nullable().default(null),
  epics: z.array(Epic).default([]),
  features: z.array(Feature).default([]),
  issues: z.array(Issue).default([]),
  prs: z.array(PR).default([]),
  prRevisions: z.array(PrRevision).default([]),
  revisionGateSnapshots: z.array(RevisionGateSnapshot).default([]),
  evalRuns: z.array(EvalRun).default([]),
  evalTasks: z.array(EvalTask).default([]),
  regressionRuns: z.array(RegressionRun).default([]), // ③ regression executions (additive)
  promptRecords: z.array(PromptRecord).default([]), // audit trail of issued prompts (additive)
  agentInvocations: z.array(AgentInvocation).default([]), // provider-neutral invocation provenance (additive)
  intakeRecords: z.array(IntakeRecord).default([]), // external Source Issue claims (additive)
  planningEnrichments: z.array(PlanningEnrichmentRecord).default([]), // trace-gated planning decisions
  interventions: z.array(Intervention).default([]), // attested human HOW-interventions (additive)
  turnRecords: z.array(TurnRecord).default([]), // per-live-turn concurrency facts (additive)
  specStates: z.array(SpecState).default([]),
});
export type DB = z.infer<typeof DB>;

export function emptyDB(): DB {
  return DB.parse({});
}
