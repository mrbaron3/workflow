/**
 * Real evaluator-perspective backend (ADR-0006 E1/E3): each of the six non-functionality
 * lenses is graded by its own read-only Claude session, which writes a findings.json the
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
import { Severity, Verdict, type IssueContract } from '../../domain/schema.js';
import type { HarnessConfig } from '../../config.js';
import { PerspectiveResult, deterministicPerspectiveGrade, type PerspectiveGrader, type PerspectiveSpec } from '../panel.js';
import { changedFiles, createDetachedWorktree, removeWorktree } from './worktree.js';
import { launchSession, sendPrompt, capturePane, killSession, monitorLiveness, type LivenessOutcome } from './tmux.js';
import { mapPool } from './pool.js';

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
    `- You may run the test suite (and targeted mutations of your own reasoning) to check;`,
    `  running code is encouraged, editing it is forbidden.`,
  ],
};

/**
 * What a perspective session writes to findings.json. Lenient on the finding shape (an LLM
 * fills it) — normalised into the strict Finding schema by parsePerspectiveFindings.
 */
const RawFinding = z.object({
  criterionId: z.string().min(1),
  severity: Severity,
  expected: z.string().default(''),
  observed: z.string().default(''),
  requiredFix: z.array(z.string()).default([]),
});
export const PerspectiveFindingsInput = z.object({
  verdict: Verdict,
  findings: z.array(RawFinding).default([]),
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
    })),
    scores: ZERO_SCORES,
    overall,
  });
}

/** Where a perspective session writes its verdict, relative to the worktree. */
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

/** The read-only briefing a perspective session runs on (it writes only its findings.json). */
export function perspectivePrompt(perspective: string, contract: IssueContract, evalRelDir: string): string {
  const lens = PERSPECTIVE_LENS[perspective] ?? 'correctness and quality for this lens';
  const rubric = PERSPECTIVE_RUBRIC[perspective] ?? [];
  return [
    `You are a code reviewer. Review ONLY through the ${perspective} lens: ${lens}.`,
    `This is a READ-ONLY review: do NOT edit any source file. Read the working tree and judge it`,
    `against the acceptance criteria below.`,
    ...(rubric.length ? ['', ...rubric] : []),
    ``,
    `## Acceptance criteria`,
    ...contract.acceptanceCriteria.map((a) => `- [${a.id}] (${a.severity}) ${a.behavior}`),
    ``,
    `## Output`,
    `Write your verdict to ${evalRelDir}/findings.json as JSON:`,
    `{"verdict": "approve" | "request_changes", "score": <0..1>,`,
    ` "findings": [{"criterionId": "...", "severity": "blocker|major|minor",`,
    `   "observed": "...", "expected": "...", "requiredFix": ["..."]}]}`,
    `Approve only if nothing in your lens needs changing. Do not edit code — only write findings.json.`,
  ].join('\n');
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
}

export interface PerspectiveSessionsResult {
  evalRoot: string;
  /** perspectives whose findings.json was collected — completed sessions plus stuck/timeout ones
   *  whose findings existed at collection time (others → runPanel escalates). */
  completed: string[];
  touchedCode: string[]; // perspectives that illegally edited the tree (read-only violation)
}

export interface ReviewJob {
  key: string;
  reviewWt: string;
  sentinel: string; // where this review writes findings.json (in its own worktree)
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
 * Phase-3 collection, tmux-free and deterministic (AC-LIVE-003): pull each review's findings.json
 * into the central evalRoot, deciding by SENTINEL EXISTENCE AT COLLECTION TIME, not just the
 * recorded liveness status. A review judged stuck/timeout may still have finished its findings by
 * now (the ⑤ race: a review that outlived its cap had its evidence thrown away) — if the file
 * exists, it is collected exactly like a completed review's and feeds the panel. The read-only
 * guard (AC-PANEL-008) is applied uniformly at this same point: a review that edited its checkout
 * is discarded, late or not. A review with no sentinel even now contributes nothing — runPanel
 * escalates that lens via the missing-file path (never a silent drop).
 */
export function collectFindings(
  jobs: readonly ReviewJob[],
  statuses: readonly ReviewStatus[],
  evalRoot: string,
  opts: CollectFindingsOpts = {},
): { completed: string[]; touchedCode: string[] } {
  const changed = opts.changed ?? changedFiles;
  const log = opts.log ?? (() => {});
  const completed: string[] = [];
  const touchedCode: string[] = [];
  jobs.forEach((job, i) => {
    if (!fs.existsSync(job.sentinel)) return; // nothing to collect, even late
    const edited = changed(job.reviewWt);
    if (edited.length > 0) {
      log(`  ⚠ ${job.key}: edited its checkout (${edited.join(', ')}) — review discarded`);
      touchedCode.push(job.key);
      return;
    }
    const dest = findingsPath(evalRoot, job.key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(job.sentinel, dest); // into the central evalRoot the panel grades from
    if (statuses[i] !== 'completed') log(`  ▸ ${job.key}: late findings collected from a ${statuses[i] ?? 'stuck'} review`);
    completed.push(job.key);
  });
  return { completed, touchedCode };
}

/**
 * Convene the LLM perspectives as read-only Claude sessions (ADR-0006 E1/E3) and collect each
 * findings.json into the central evalRoot (the generator worktree) for runPanel. Each review runs
 * in its OWN detached worktree of the committed build, so AC-PANEL-008 (the build is unchanged by
 * scoring) holds by construction — a review physically cannot touch the build under evaluation.
 *
 * Three phases so git worktree bookkeeping never races the fan-out: (1) create every review's
 * worktree + prompt sequentially — fast; (2) run the sessions CONCURRENTLY up to
 * config.panel.maxConcurrent (E4) — the slow part; (3) collect/teardown sequentially. A review that
 * edited its checkout is attributable and discarded; a stuck/timeout review keeps its session +
 * worktree alive (ARCH-execution-014). functionality is skipped (graded by code, E2). NOT unit-tested
 * (drives live tmux + Claude); the parse/grade + isolation seams are.
 */
export async function runPerspectiveSessions(
  config: HarnessConfig,
  input: PerspectiveSessionsInput,
  log: (m: string) => void = () => {},
): Promise<PerspectiveSessionsResult> {
  const evalRoot = path.join(input.worktree, '.agentops', 'eval'); // central collection point
  const reviewRoot = path.resolve(input.worktree, '..', '..', 'review-worktrees');
  const lenses = input.perspectives.filter((p) => !p.deterministic); // functionality is graded by code
  const maxConcurrent = config.panel?.maxConcurrent ?? 4;
  log(`  panel: ${lenses.length} live lenses, maxConcurrent=${maxConcurrent}`);

  // phase 1 (sequential): one isolated detached checkout of the build per review + its prompt
  const jobs: ReviewJob[] = lenses.map((p) => {
    const reviewWt = path.join(reviewRoot, `${input.issueKey}-${p.key}`);
    createDetachedWorktree(input.repo, input.buildRef, reviewWt);
    const dir = path.join(reviewWt, '.agentops', 'eval', p.key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'PROMPT.md'), perspectivePrompt(p.key, input.contract, `.agentops/eval/${p.key}`), 'utf8');
    return { key: p.key, reviewWt, sentinel: path.join(dir, 'findings.json') };
  });

  // phase 2 (concurrent): the read-only review sessions — the only slow, non-deterministic part
  const reviewerModel = config.models?.reviewer; // undefined = inherit the user's default model
  const statuses = await mapPool(jobs, maxConcurrent, (job) => runReviewSession(input.issueKey, job, log, reviewerModel));

  // phase 3 (sequential): collect findings — by sentinel existence at collection time, so a
  // stuck/timeout review whose findings landed after the verdict still contributes (AC-LIVE-003)
  // — then tear down finished worktrees. A stuck/timeout review keeps session + worktree alive
  // for a human (ARCH-execution-014) even when its findings were collected late.
  const { completed, touchedCode } = collectFindings(jobs, statuses, evalRoot, { log });
  jobs.forEach((job, i) => {
    if (statuses[i] === 'completed') removeWorktree(input.repo, job.reviewWt);
  });

  return { evalRoot, completed, touchedCode };
}

/**
 * Review-session liveness wiring (ISSUE-0007). Exported so the permanent guard
 * (test/acceptance-harness/active-liveness.acceptance.test.ts) can pin it: the released
 * panel's surviving major finding was that these were untested inline literals — a mutation
 * re-tightening the cap to 10 minutes (the exact ⑤ failure) survived every test.
 */
export const REVIEW_LIVENESS = { idleMs: 90_000, activeCapMs: 1000 * 60 * 60 * 2, pollMs: 3000 } as const;

/** Run one read-only review session in its prepared worktree; returns its status (no git bookkeeping). */
async function runReviewSession(issueKey: string, job: ReviewJob, log: (m: string) => void, model?: string): Promise<ReviewStatus> {
  const session = `ao-eval-${issueKey}-${job.key}`;
  log(`  ▸ ${session}: read-only review`);
  // acceptEdits + Bash so the review can inspect the tree and write findings.json WITHOUT hanging
  // on an approval prompt. Read-only is enforced by ISOLATION (own worktree) + the changedFiles
  // guard in collectFindings; a review that edits its checkout is discarded and never touches the build.
  launchSession({ session, cwd: job.reviewWt, allowedTools: ['Read', 'Write', 'Bash'], permissionMode: 'acceptEdits', model });
  await waitForReady(session);
  const submitted = await sendPrompt(session, `Read .agentops/eval/${job.key}/PROMPT.md and do exactly what it says.`);
  if (!submitted) log(`  ⚠ ${session}: prompt may not have submitted — liveness monitor will surface it if stuck`);
  // No per-review soft cap: a review still visibly working (⑤ ran 1h26m past the old 10-min
  // cap and its findings were lost) is kept alive up to the finite REVIEW_LIVENESS ceiling;
  // going idle on the way still surfaces as stuck via idleMs.
  const outcome = await monitorLiveness(session, job.sentinel, REVIEW_LIVENESS);

  if (outcome !== 'completed') {
    log(`  ⚠ ${session}: ${outcome} — session + worktree kept alive; inspect: tmux attach -t ${session}`);
    return outcome;
  }
  killSession(session);
  // The read-only guard (AC-PANEL-008) runs in collectFindings, at collection time, so a
  // late-collected stuck/timeout review passes the SAME dirty-checkout gate as a completed one.
  return 'completed';
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitForReady(session: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (/accept edits on|❯/.test(capturePane(session))) return;
    await sleep(500);
  }
}
