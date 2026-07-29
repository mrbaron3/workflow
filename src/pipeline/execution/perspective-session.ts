/**
 * Real evaluator-perspective backend (ADR-0006 E1/E3): each of the six non-functionality
 * lenses is graded by its own provider-routed, isolated review session, which writes a findings.json the
 * harness parses into a PerspectiveResult.
 *
 * The seam is split so runPanel stays synchronous and deterministic (ARCH-execution-011):
 *   1. runPerspectiveSessions (async, non-deterministic) spawns the tmux sessions and waits
 *      for each findings.json sentinel — the "produce the artifact" half.
 *   2. fileBackedGrader (sync, pure) reads + validates those files into PerspectiveResults —
 *      the "grade from the artifact" half, plugged straight into runPanel via opts.grader.
 * A session that writes malformed output fails validation here and runPanel escalates it to
 * needs-human-review (AC-PANEL-006) — it is never trusted as an approval.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  FindingLineage,
  Severity,
  Verdict,
  type AgentProvider,
  type ApprovedDesignReviewProjection,
  type DesignAuthority,
  type Finding,
  type IssueContract,
  type UiDesignArtifact,
} from '../../domain/schema.js';
import { resolvePanelMaxConcurrent, type HarnessConfig } from '../../config.js';
import { PerspectiveResult, deterministicPerspectiveGrade, type PerspectiveGrader, type PerspectiveSpec } from '../panel.js';
import { changedFiles, createDetachedWorktree, removeWorktree } from './worktree.js';
import type { LivenessOutcome } from './tmux.js';
import { resolveAgentRoute, type AgentRoute } from '../../agents/routing.js';
import { mapPool } from './pool.js';
import { runRestrictedReviewSession, staticUntrustedReviewMaterial } from './restricted-review.js';
import { runReviewSession } from './review-session-runner.js';
import {
  MAX_REVIEW_CRITERION_ID_CHARS,
  MAX_REVIEW_FINDINGS,
  MAX_REVIEW_FINDING_TEXT_CHARS,
  MAX_REVIEW_REQUIRED_FIX_CHARS,
  MAX_REVIEW_REQUIRED_FIXES,
} from './review-output-limits.js';
import { renderAuthoritativeDesignContext } from '../../designflow/authority.js';
export { REVIEW_LIVENESS } from './review-liveness.js';
export {
  appendRestrictedReviewOutput,
  MAX_UNTRUSTED_REVIEW_MATERIAL_BYTES,
  STATIC_REVIEW_DIFF_CONTEXT_LINES,
  prepareRestrictedReviewExecution,
  restrictedPerspectivePrompt,
  restrictedReviewLaunch,
  staticUntrustedReviewMaterial,
} from './restricted-review.js';
export {
  MAX_RESTRICTED_REVIEW_OUTPUT_BYTES,
  MAX_REVIEW_CRITERION_ID_CHARS,
  MAX_REVIEW_FINDINGS,
  MAX_REVIEW_FINDING_TEXT_CHARS,
  MAX_REVIEW_REQUIRED_FIX_CHARS,
  MAX_REVIEW_REQUIRED_FIXES,
} from './review-output-limits.js';

/** The review focus each perspective session is briefed on (single source; no per-file personas). */
export const PERSPECTIVE_LENS: Record<string, string> = {
  codeQuality: 'clarity, naming, structure, duplication, dead code, and adherence to the surrounding style',
  testQuality: 'test coverage of the acceptance criteria, edge/error/boundary cases, and meaningful assertions',
  ux: 'the user-facing behaviour: clear states, error messages, empty/loading states, and sensible defaults',
  accessibility: 'semantics, keyboard operability, labels/alt text, focus handling, and contrast',
  security: 'input validation, injection, authz/authn, secret handling, and unsafe defaults',
  'type-design': 'types that make illegal states unrepresentable, encapsulation, and precise signatures',
};

/**
 * Per-lens VALIDITY rubric appended to the briefing. testQuality is the independent agent
 * that reviews test CONTENT (the generator grades its own homework otherwise): it judges
 * whether the tests would actually catch a regression, not merely that tests exist.
 */
export const PERSPECTIVE_RUBRIC: Record<string, string[]> = {
  testQuality: [
    `Validity rubric — judge the tests as evidence, not as decoration:`,
    `- For each test, ask: would it FAIL if the behaviour it names broke? Flag tautologies`,
    `  (assertions that restate the implementation or can never fail) as findings.`,
    `- Every acceptance criterion must have at least one test whose title carries its AC id`,
    `  (the harness binds grading and regression re-runs to those titles); flag untagged or`,
    `  missing criteria.`,
    `- Flag tests that mirror the implementation's internals instead of the contract's`,
    `  observable behaviour, and assertions weakened to pass (loose tolerances, skipped cases).`,
    `- Inspect the change for operational constants (timeouts, retry counts, caps, thresholds)`,
    `  wired as inline literals at a callsite: if a value-breaking mutation of the constant`,
    `  would survive the whole suite, that is a finding — require a single-source exported`,
    `  constant with a test pinning its value or required property.`,
    `- You may run the test suite (and targeted mutations of your own reasoning) to check;`,
    `  running code is encouraged, editing it is forbidden.`,
  ],
};

/**
 * What a perspective session writes to findings.json. Lenient on the finding shape (an LLM
 * fills it) — normalised into the strict Finding schema by parsePerspectiveFindings.
 */
const RawFinding = z.object({
  criterionId: z.string().min(1).max(MAX_REVIEW_CRITERION_ID_CHARS),
  severity: Severity,
  expected: z.string().max(MAX_REVIEW_FINDING_TEXT_CHARS).default(''),
  observed: z.string().max(MAX_REVIEW_FINDING_TEXT_CHARS).default(''),
  requiredFix: z.array(z.string().max(MAX_REVIEW_REQUIRED_FIX_CHARS))
    .max(MAX_REVIEW_REQUIRED_FIXES)
    .default([]),
  // Re-review attestation (ISSUE-0009): strictly 'persisted' | 'new' or absent. An invalid
  // value fails the whole parse (→ escalate) — never coerced, never defaulted.
  lineage: FindingLineage.nullable().optional(),
});
export const PerspectiveFindingsInput = z.object({
  verdict: Verdict,
  findings: z.array(RawFinding).max(MAX_REVIEW_FINDINGS).default([]),
  /** Optional 0..1 quality score for this lens; defaults from the verdict when absent. */
  score: z.number().min(0).max(1).optional(),
});
export type PerspectiveFindingsInput = z.infer<typeof PerspectiveFindingsInput>;

const ZERO_SCORES = { functionality: 0, codeQuality: 0, testQuality: 0, ux: 0, accessibility: 0 };

/**
 * Parse + validate a perspective session's raw output into a PerspectiveResult. Throws on
 * anything malformed (missing verdict, bad severity, wrong shape) so the caller escalates
 * rather than trusting a broken review (AC-PANEL-006). `raw` is the parsed JSON object.
 */
export function parsePerspectiveFindings(raw: unknown): PerspectiveResult {
  const input = PerspectiveFindingsInput.parse(raw); // throws on invalid
  const overall = input.score ?? (input.verdict === 'approve' ? 1 : 0.3);
  return PerspectiveResult.parse({
    verdict: input.verdict,
    findings: input.findings.map((f) => ({
      criterionId: f.criterionId,
      severity: f.severity,
      expected: f.expected,
      observed: f.observed,
      reproductionSteps: [],
      evidence: { trace: 'findings.json' },
      requiredFix: f.requiredFix,
      // absent stays absent (legacy) — never silently classified either way
      ...(f.lineage ? { lineage: f.lineage } : {}),
    })),
    scores: ZERO_SCORES,
    overall,
  });
}

/** Where the panel reads a collected perspective verdict under the central eval root. */
export function findingsPath(evalRoot: string, perspective: string): string {
  return path.join(evalRoot, perspective, 'findings.json');
}

/**
 * A synchronous PerspectiveGrader that reads each perspective's already-written findings.json.
 * Plugs into runPanel unchanged. Missing or malformed files throw → runPanel escalates.
 */
export function fileBackedGrader(evalRoot: string): PerspectiveGrader {
  return (perspective) => {
    const raw = fs.readFileSync(findingsPath(evalRoot, perspective), 'utf8'); // throws if absent
    return parsePerspectiveFindings(JSON.parse(raw)); // throws if malformed
  };
}

/**
 * The grader runPanel uses with the real backend: functionality is graded by code (E2), the
 * six review lenses by their session's findings.json. Missing/malformed files throw → escalate.
 */
export function sessionBackedGrader(evalRoot: string): PerspectiveGrader {
  const file = fileBackedGrader(evalRoot);
  return (perspective, contract, artifact, config) =>
    perspective === 'functionality'
      ? deterministicPerspectiveGrade(perspective, contract, artifact, config)
      : file(perspective, contract, artifact, config);
}

/** What a re-review prompt shows of a prior finding — enough to recognise the problem. */
export type PriorFinding = Pick<Finding, 'criterionId' | 'observed'>;

export interface ImmutableReviewTarget {
  headSha: string;
  baseRef?: string;
}

/**
 * The read-only briefing a perspective session runs on (it writes only its sidecar findings.json).
 * On a re-review (ISSUE-0009), `priorFindings` — the SAME lens's previous-attempt findings —
 * are presented and the reviewer must attest each reported finding's lineage ('persisted' |
 * 'new'); with no priors (attempt 1) the prompt is unchanged.
 */
export function perspectivePrompt(
  perspective: string,
  contract: IssueContract,
  evalRelDir: string,
  priorFindings: readonly PriorFinding[] = [],
  uiDesign: UiDesignArtifact | null = null,
  reviewTarget: ImmutableReviewTarget | null = null,
  surrogateOracleMismatchCount = 0,
  designAuthority: DesignAuthority | null = null,
  designReview: ApprovedDesignReviewProjection | null = null,
): string {
  const lens = PERSPECTIVE_LENS[perspective] ?? 'correctness and quality for this lens';
  const rubric = PERSPECTIVE_RUBRIC[perspective] ?? [];
  const reReview = priorFindings.length > 0;
  return [
    `You are a code reviewer. Review ONLY through the ${perspective} lens: ${lens}.`,
    `This is a READ-ONLY review: do NOT edit any source file. Read the working tree and judge it`,
    `against the acceptance criteria below.`,
    ...(rubric.length ? ['', ...rubric] : []),
    ``,
    `## Acceptance criteria`,
    ...contract.acceptanceCriteria.map((a) => `- [${a.id}] (${a.severity}) ${a.behavior}`),
    ...(reviewTarget
      ? [
          ``,
          `## Immutable review target`,
          `- Head SHA: ${reviewTarget.headSha}`,
          ...(reviewTarget.baseRef ? [`- Base ref: ${reviewTarget.baseRef}`] : []),
          `Review only this committed head${reviewTarget.baseRef ? ` and the complete ${reviewTarget.baseRef}...${reviewTarget.headSha} diff` : ''}.`,
          `If any carried contract or prior finding names another SHA, it is stale evidence and must be ignored.`,
        ]
      : []),
    ...(uiDesign
      ? [
          ``,
          `## UI Design Contract`,
          JSON.stringify(uiDesign, null, 2),
          `Judge the implementation against this accepted design contract without inventing new UI scope.`,
        ]
      : []),
    ...(designAuthority
      ? [
          ``,
          renderAuthoritativeDesignContext(designAuthority, designReview),
          `Implementations and review evidence must remain bound to this exact design revision.`,
        ]
      : []),
    ...(reReview
      ? [
          ``,
          `## Prior findings (this lens, previous attempt)`,
          `This is a re-review after a repair attempt. Your previous review of this lens raised:`,
          ...priorFindings.map((f) => `- [${f.criterionId}] ${f.observed}`),
          `You MUST attest the lineage of EVERY finding you report:`,
          `- "persisted" — the same problem as one listed above is still present.`,
          `- "new" — a problem you found in this review that is not one of the findings above.`,
          `Judge by the problem's substance, not by criterion id — a survivor may resurface under`,
          `a different criterionId, and a fresh problem may hit the same one.`,
        ]
      : []),
    ...(surrogateOracleMismatchCount > 0
      ? [
          ``,
          `## Opaque external-verification feedback`,
          `On ${surrogateOracleMismatchCount} earlier PR revision(s), every internal review perspective`,
          `approved, but independent external verification rejected the revision. You are intentionally`,
          `not given its failure details. Treat this only as evidence that the surrogate review coverage was incomplete.`,
          `Strengthen the ${perspective} verification independently: challenge prior assumptions, add diverse`,
          `edge and adversarial cases, and prefer executable or otherwise falsifiable checks.`,
          `Do not speculate about hidden checks or optimize to a guessed answer.`,
        ]
      : []),
    ``,
    `## Output`,
    `Write your verdict to ${evalRelDir}/findings.json as JSON:`,
    `{"verdict": "approve" | "request_changes", "score": <0..1>,`,
    ` "findings": [{"criterionId": "...", "severity": "blocker|major|minor",`,
    ...(reReview
      ? [`   "observed": "...", "expected": "...", "requiredFix": ["..."],`, `   "lineage": "persisted" | "new"}]}`]
      : [`   "observed": "...", "expected": "...", "requiredFix": ["..."]}]}`]),
    `Use request_changes only for a concrete blocker or major defect. Minor suggestions may be`,
    `reported with approve and must never be promoted solely because of function length, style,`,
    `or an unproven hypothetical. Do not edit code — only write findings.json.`,
  ].join('\n');
}

/**
 * Resolve ONE lens's briefing from the per-lens prior-findings map — the re-review handoff
 * seam (ISSUE-0009). A lens keyed in the map gets the re-review prompt with ITS OWN priors;
 * a lens absent from the map (or no map at all — attempt 1) gets the unchanged first-review prompt.
 */
export function promptForLens(
  perspective: string,
  contract: IssueContract,
  evalRelDir: string,
  priorFindings?: Record<string, readonly PriorFinding[]>,
  uiDesign: UiDesignArtifact | null = null,
  reviewTarget: ImmutableReviewTarget | null = null,
  surrogateOracleMismatchCount = 0,
  designAuthority: DesignAuthority | null = null,
  designReview: ApprovedDesignReviewProjection | null = null,
): string {
  return perspectivePrompt(
    perspective,
    contract,
    evalRelDir,
    priorFindings?.[perspective] ?? [],
    uiDesign,
    reviewTarget,
    surrogateOracleMismatchCount,
    designAuthority,
    designReview,
  );
}

export interface PerspectiveSessionsInput {
  /** The generator's worktree — the collection point for findings (central evalRoot). */
  worktree: string;
  contract: IssueContract;
  perspectives: PerspectiveSpec[];
  issueKey: string;
  /** The target repo (owns the build branch) — where each review's detached worktree is added. */
  repo: string;
  /** The committed build to review — the generator's branch (or its commit SHA). */
  buildRef: string;
  /** Base ref used to materialize a static diff for an untrusted repository PR. */
  baseRef?: string;
  /**
   * Repository-discovered PRs are attacker-controlled. Their reviewers receive a
   * static diff in a no-tool process instead of filesystem/tool access.
   */
  untrusted?: boolean;
  /** Re-review (attempt > 1): each lens's findings from the previous attempt, keyed by lens.
   *  Absent/empty per lens = first review, that lens's prompt is unchanged (ISSUE-0009). */
  priorFindings?: Record<string, readonly PriorFinding[]>;
  /** Accepted UI design contract, when the issue required the dedicated authoring gate. */
  uiDesign?: UiDesignArtifact | null;
  /** Exact single-provider revision authority shared with the generator prompt. */
  designAuthority?: DesignAuthority | null;
  /** Canonical WF-DF-005 content bound to designAuthority. */
  designReview?: ApprovedDesignReviewProjection | null;
  /**
   * Number of earlier PR revisions where every surrogate perspective approved
   * but an independent external oracle rejected. Only the count crosses into
   * the reviewer session; the oracle's answer remains isolated.
   */
  surrogateOracleMismatchCount?: number;
}

/** Pin the production session-input → reviewer-prompt calibration seam. */
export function perspectiveSessionPrompt(
  input: PerspectiveSessionsInput,
  perspective: string,
  evalRelDir: string,
): string {
  return promptForLens(
    perspective,
    input.contract,
    evalRelDir,
    input.priorFindings,
    input.uiDesign,
    {
      headSha: input.buildRef,
      ...(input.baseRef ? { baseRef: input.baseRef } : {}),
    },
    input.surrogateOracleMismatchCount,
    input.designAuthority,
    input.designReview,
  );
}

export interface PerspectiveSessionsResult {
  evalRoot: string;
  /** perspectives whose findings.json was collected — completed sessions plus stuck/timeout ones
   *  whose findings existed at collection time (others → runPanel escalates). */
  completed: string[];
  touchedCode: string[]; // perspectives that illegally edited the tree (read-only violation)
  /** Explicitly allowed dependency-tool byproducts, keyed by the perspective that made them. */
  environmentChanges: Record<string, string[]>;
  /** Actual role-session provenance returned to the deterministic orchestrator for persistence. */
  invocations: ReviewerSessionInvocation[];
}

export interface ReviewerSessionInvocation {
  role: 'reviewer';
  perspective: string;
  provider: AgentProvider;
  model: string | null;
  prompt: string;
  outcome: ReviewStatus;
}

/** Deterministic projection of live reviewer jobs into provider-neutral provenance records. */
export function reviewerSessionInvocations(
  jobs: readonly ReviewJob[],
  statuses: readonly ReviewStatus[],
  routes: Readonly<Record<string, AgentRoute>>,
): ReviewerSessionInvocation[] {
  return jobs.map((job, index) => {
    const route = routes[job.key];
    if (!route) throw new Error(`Missing reviewer route for perspective: ${job.key}`);
    return {
      role: 'reviewer',
      perspective: job.key,
      provider: route.provider,
      model: route.model,
      prompt: fs.readFileSync(job.prompt, 'utf8'),
      outcome: statuses[index]!,
    };
  });
}

export interface ReviewJob {
  key: string;
  reviewWt: string;
  prompt: string;
  sentinel: string; // findings.json in the review evidence sidecar, outside reviewWt
  restricted?: boolean;
  /** Frozen repository diff passed only through the provider's low-trust user-input channel. */
  untrustedMaterial?: string;
}
/** A review's recorded liveness verdict, preserved as-is (never collapsed) so late collection
 *  can tell the operator which failure mode — stuck or timeout — the review actually had. */
export type ReviewStatus = LivenessOutcome;

export interface CollectFindingsOpts {
  /** Injectable dirty-checkout probe (default: git-backed changedFiles) — the read-only guard. */
  changed?: (worktree: string) => string[];
  log?: (m: string) => void;
}

/**
 * Dependency metadata that a package-manager check may rewrite while merely installing or
 * verifying dependencies. The allow-list is exact by basename: arbitrary generated files,
 * manifests, source and config remain sourceChanges and fail closed.
 */
export const REVIEW_ENVIRONMENT_ARTIFACT_BASENAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
]);

export interface ReviewChangePartition {
  environmentArtifacts: string[];
  sourceChanges: string[];
}

/** Pure, order-independent classification used by phase-3 collection. */
export function partitionReviewChanges(files: readonly string[]): ReviewChangePartition {
  const unique = [...new Set(files.map((file) => file.replaceAll('\\', '/')))].sort();
  return {
    environmentArtifacts: unique.filter((file) => REVIEW_ENVIRONMENT_ARTIFACT_BASENAMES.has(path.posix.basename(file))),
    sourceChanges: unique.filter((file) => !REVIEW_ENVIRONMENT_ARTIFACT_BASENAMES.has(path.posix.basename(file))),
  };
}

/**
 * Deterministic physical identities for one review. The checkout and evidence roots are
 * separate inputs so a caller cannot accidentally place prompt/findings beneath reviewWt.
 */
export function reviewJobPaths(
  reviewRoot: string,
  evidenceRoot: string,
  issueKey: string,
  perspective: string,
): ReviewJob {
  const evidenceDir = path.join(
    evidenceRoot,
    `issue-${encodeURIComponent(issueKey)}`,
    `perspective-${encodeURIComponent(perspective)}`,
  );
  return {
    key: perspective,
    reviewWt: path.join(reviewRoot, `${issueKey}-${perspective}`),
    prompt: path.join(evidenceDir, 'PROMPT.md'),
    sentinel: path.join(evidenceDir, 'findings.json'),
  };
}

/**
 * Phase 1 of the production fan-out: materialize each isolated review target and
 * write the exact prompt that the provider session will consume.
 */
export function preparePerspectiveSessionJobs(
  input: PerspectiveSessionsInput,
  reviewRoot: string,
  evidenceRoot: string,
  restrictedMaterial: string | null,
): ReviewJob[] {
  return input.perspectives
    .filter((perspective) => !perspective.deterministic)
    .map((perspective) => {
      const job = reviewJobPaths(
        reviewRoot,
        evidenceRoot,
        input.issueKey,
        perspective.key,
      );
      if (!input.untrusted) {
        createDetachedWorktree(input.repo, input.buildRef, job.reviewWt);
      }
      const evidenceDir = path.dirname(job.sentinel);
      fs.rmSync(evidenceDir, { recursive: true, force: true });
      fs.mkdirSync(evidenceDir, { recursive: true });
      if (input.untrusted) {
        fs.mkdirSync(job.reviewWt, { recursive: true });
        job.restricted = true;
        job.untrustedMaterial = restrictedMaterial ?? undefined;
      }
      fs.writeFileSync(
        job.prompt,
        perspectiveSessionPrompt(input, perspective.key, evidenceDir),
        'utf8',
      );
      return job;
    });
}

/**
 * Phase-3 collection, tmux-free and deterministic (AC-LIVE-003): pull each review's findings.json
 * into the central evalRoot, deciding by SENTINEL EXISTENCE AT COLLECTION TIME, not just the
 * recorded liveness status. A review judged stuck/timeout may still have finished its findings by
 * now (the ⑤ race: a review that outlived its cap had its evidence thrown away) — if the file
 * exists, it is collected exactly like a completed review's and feeds the panel. The read-only
 * guard (AC-PANEL-008) is applied uniformly at this same point: a review that edited source/config
 * is discarded, late or not. Explicit dependency lockfile byproducts are attributed but do not
 * erase otherwise valid evidence. A review with no sentinel even now contributes nothing —
 * runPanel escalates that lens via the missing-file path (never a silent drop).
 */
export function collectFindings(
  jobs: readonly ReviewJob[],
  statuses: readonly ReviewStatus[],
  evalRoot: string,
  opts: CollectFindingsOpts = {},
): { completed: string[]; touchedCode: string[]; environmentChanges: Record<string, string[]> } {
  const changed = opts.changed ?? changedFiles;
  const log = opts.log ?? (() => {});
  const completed: string[] = [];
  const touchedCode: string[] = [];
  const environmentChanges: Record<string, string[]> = {};
  jobs.forEach((job, i) => {
    if (!fs.existsSync(job.sentinel)) return; // nothing to collect, even late
    const edited = job.restricted
      ? { environmentArtifacts: [], sourceChanges: [] }
      : partitionReviewChanges(changed(job.reviewWt));
    if (edited.sourceChanges.length > 0) {
      log(`  ⚠ ${job.key}: edited its checkout (${edited.sourceChanges.join(', ')}) — review discarded`);
      touchedCode.push(job.key);
      return;
    }
    if (edited.environmentArtifacts.length > 0) {
      environmentChanges[job.key] = edited.environmentArtifacts;
      log(`  ▸ ${job.key}: environment artifacts changed (${edited.environmentArtifacts.join(', ')}) — findings retained`);
    }
    const dest = findingsPath(evalRoot, job.key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(job.sentinel, dest); // into the central evalRoot the panel grades from
    if (statuses[i] !== 'completed') log(`  ▸ ${job.key}: late findings collected from a ${statuses[i] ?? 'stuck'} review`);
    completed.push(job.key);
  });
  return { completed, touchedCode, environmentChanges };
}

/**
 * Convene the LLM perspectives as provider-routed isolated sessions (ADR-0006 E1/E3) and collect each
 * findings.json into the central evalRoot (the generator worktree) for runPanel. Each review runs
 * in its OWN detached worktree of the committed build, so AC-PANEL-008 (the build is unchanged by
 * scoring) holds by construction — a review physically cannot touch the build under evaluation.
 *
 * Three phases so git worktree bookkeeping never races the fan-out: (1) create every review's
 * worktree + prompt sequentially — fast; (2) run the sessions CONCURRENTLY up to
 * config.panel.maxConcurrent (E4) — the slow part; (3) collect/teardown sequentially. A review that
 * edited source/config in its checkout is attributable and discarded; a stuck/timeout review keeps its session +
 * worktree alive (ARCH-execution-014). functionality is skipped (graded by code, E2). NOT unit-tested
 * (drives live tmux + external provider CLIs); the parse/grade + isolation seams are.
 */
export async function runPerspectiveSessions(
  config: HarnessConfig,
  input: PerspectiveSessionsInput,
  log: (m: string) => void = () => {},
): Promise<PerspectiveSessionsResult> {
  const evalRoot = path.join(input.worktree, '.agentops', 'eval'); // central collection point
  const harnessStateRoot = path.resolve(input.worktree, '..', '..');
  const reviewRoot = path.join(harnessStateRoot, 'review-worktrees');
  const evidenceRoot = path.join(harnessStateRoot, 'review-evidence');
  const lenses = input.perspectives.filter((p) => !p.deterministic); // functionality is graded by code
  const maxConcurrent = resolvePanelMaxConcurrent(config);
  log(`  panel: ${lenses.length} live lenses, maxConcurrent=${maxConcurrent}`);
  const restrictedMaterial = input.untrusted
    ? staticUntrustedReviewMaterial(input.repo, input.baseRef ?? 'main', input.buildRef)
    : null;

  // phase 1 (sequential): one isolated detached checkout of the build per review + its prompt
  const jobs = preparePerspectiveSessionJobs(
    input,
    reviewRoot,
    evidenceRoot,
    restrictedMaterial,
  );

  // phase 2 (concurrent): the read-only review sessions — the only slow, non-deterministic part
  const routes = Object.fromEntries(jobs.map((job) => [job.key, resolveAgentRoute(config, 'reviewer', job.key)]));
  const statuses = await mapPool(jobs, maxConcurrent, (job) =>
    job.restricted
      ? runRestrictedReviewSession(input.issueKey, job, log, routes[job.key]!, parsePerspectiveFindings)
      : runReviewSession(input.issueKey, job, log, routes[job.key]!));

  // phase 3 (sequential): collect findings — by sentinel existence at collection time, so a
  // stuck/timeout review whose findings landed after the verdict still contributes (AC-LIVE-003)
  // — then tear down finished worktrees. A stuck/timeout review keeps session + worktree alive
  // for a human (ARCH-execution-014) even when its findings were collected late.
  const { completed, touchedCode, environmentChanges } = collectFindings(jobs, statuses, evalRoot, { log });
  jobs.forEach((job, i) => {
    if (statuses[i] !== 'completed') return;
    if (job.restricted) fs.rmSync(job.reviewWt, { recursive: true, force: true });
    else removeWorktree(input.repo, job.reviewWt);
  });

  const invocations = reviewerSessionInvocations(jobs, statuses, routes);
  return { evalRoot, completed, touchedCode, environmentChanges, invocations };
}
