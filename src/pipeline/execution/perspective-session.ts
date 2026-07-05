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
import { changedFiles } from './worktree.js';
import { launchSession, sendPrompt, capturePane, killSession, monitorLiveness } from './tmux.js';

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
  return [
    `You are a code reviewer. Review ONLY through the ${perspective} lens: ${lens}.`,
    `This is a READ-ONLY review: do NOT edit any source file. Read the working tree and judge it`,
    `against the acceptance criteria below.`,
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
  worktree: string;
  contract: IssueContract;
  perspectives: PerspectiveSpec[];
  issueKey: string;
}

export interface PerspectiveSessionsResult {
  evalRoot: string;
  /** perspectives whose session completed and left a findings.json (others → runPanel escalates). */
  completed: string[];
  touchedCode: string[]; // perspectives that illegally edited the tree (read-only violation)
}

/**
 * Spawn one read-only Claude session per (LLM) perspective, sequentially so a read-only
 * violation is attributable, and wait for each to write findings.json. Deterministic
 * perspectives (functionality, ADR-0006 E2) are skipped — they are graded by code, not a
 * session. NOT unit-tested (drives live tmux + Claude); the parse/grade seam it feeds is.
 */
export async function runPerspectiveSessions(
  config: HarnessConfig,
  input: PerspectiveSessionsInput,
  log: (m: string) => void = () => {},
): Promise<PerspectiveSessionsResult> {
  const evalRoot = path.join(input.worktree, '.agentops', 'eval');
  const completed: string[] = [];
  const touchedCode: string[] = [];

  for (const p of input.perspectives) {
    if (p.deterministic) continue; // functionality is graded by code
    const dir = path.join(evalRoot, p.key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'PROMPT.md'), perspectivePrompt(p.key, input.contract, `.agentops/eval/${p.key}`), 'utf8');
    const sentinel = findingsPath(evalRoot, p.key);
    fs.rmSync(sentinel, { force: true });

    const before = new Set(changedFiles(input.worktree));
    const session = `ao-eval-${input.issueKey}-${p.key}`;
    log(`  ▸ ${session}: read-only review`);
    // Read to inspect the tree; Write to produce findings.json only (enforced by the post-check).
    launchSession({ session, cwd: input.worktree, allowedTools: ['Read', 'Write'], permissionMode: 'default' });
    await waitForReady(session);
    sendPrompt(session, `Read .agentops/eval/${p.key}/PROMPT.md and do exactly what it says.`);
    const outcome = await monitorLiveness(session, sentinel, { idleMs: 90_000, hardCapMs: 1000 * 60 * 10, pollMs: 3000 });

    if (outcome === 'completed') {
      killSession(session);
      // read-only guard (AC-PANEL-008): the review must not have edited the tree
      const added = changedFiles(input.worktree).filter((f) => !before.has(f));
      if (added.length > 0) {
        touchedCode.push(p.key);
        log(`  ⚠ ${session}: edited the tree (${added.join(', ')}) — review discarded`);
        fs.rmSync(sentinel, { force: true }); // discard: runPanel will escalate this perspective
      } else {
        completed.push(p.key);
      }
    } else {
      log(`  ⚠ ${session}: ${outcome} — kept alive; inspect: tmux attach -t ${session}`);
    }
  }
  return { evalRoot, completed, touchedCode };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitForReady(session: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (/accept edits on|❯/.test(capturePane(session))) return;
    await sleep(500);
  }
}
