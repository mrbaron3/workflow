/**
 * One generator role-session (ARCH-execution-003 + 004 + 005).
 *
 * Ties the pieces the smoke test validated into a single call: fresh worktree → launch an
 * provider-routed interactive session in tmux → drive it with a one-line kickoff that points at a
 * prompt FILE (send-keys can't carry multi-line text) → wait for the sentinel → capture
 * pane for evidence → tear the session down. Returns what the checkout looks like; grading
 * is a separate, deterministic step.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as YAML from 'yaml';
import type { AgentProvider, Issue, IssueContract } from '../../domain/schema.js';
import type { HarnessConfig, TargetRepoConfig } from '../../config.js';
import type { RepairBrief } from '../../domain/artifact.js';
import { loadRolePrompt } from '../../agents/prompts.js';
import {
  createWorktree,
  worktreeExists,
  changedFiles,
  commitBuild,
  buildChangedFiles,
  headCommit,
} from './worktree.js';
import { launchSession, capturePane, killSession, monitorLiveness, type LivenessOutcome } from './tmux.js';
import { resolveAgentRoute } from '../../agents/routing.js';
import { contextFor, renderScopedContext } from './scoped-context.js';
import { submitPromptWhenSessionReady } from './session-readiness.js';
import { renderAuthoritativeDesignContext } from '../../designflow/authority.js';

export interface GeneratorSessionInput {
  issue: Issue;
  contract: IssueContract;
  sampleIndex: number;
  attempt: number;
  /** Present on repair attempts (attempt > 1): the reviewers' required fixes to apply on top. */
  repairBrief?: RepairBrief | null;
  /** Existing PR head used to reconstruct a missing repair worktree after restart. */
  resumeRef?: string | null;
}

export interface SessionResult {
  /** Provider that actually executed the session (not the configured routing intent). */
  provider: AgentProvider;
  model: string | null;
  worktree: string;
  branch: string;
  session: string;
  outcome: LivenessOutcome;
  changed: string[];
  /** Immutable build revision. null only when no build commit exists. */
  headSha: string | null;
  paneTail: string;
  /** The exact prompt written to PROMPT.md this attempt — returned so the orchestrator can persist
   *  it for audit (the file itself is overwritten next attempt and wiped with .harness/). */
  prompt: string;
}

/**
 * Generator-session liveness wiring (ISSUE-0007). Exported so the permanent guard
 * (test/acceptance-harness/active-liveness.acceptance.test.ts) can pin it — the panel's
 * surviving major finding was that these caps were untested inline literals. Finite
 * activeCapMs ceiling for a still-working session; idle still surfaces as stuck via idleMs.
 */
export const GENERATOR_LIVENESS = { idleMs: 90_000, activeCapMs: 1000 * 60 * 60 * 4, pollMs: 3000 } as const;

/** Repository-discovered repairs start at the observed PR head, including their first AgentOps turn. */
export function generatorStartRef(
  resumeRef: string | null | undefined,
  configuredBaseRef: string,
): string {
  return resumeRef ?? configuredBaseRef;
}

/** A repair workspace is reusable only while it still represents the current PR head. */
export function generatorWorktreeRequiresReset(
  attempt: number,
  exists: boolean,
  worktreeHead: string | null,
  resumeRef: string | null | undefined,
): boolean {
  return attempt === 1
    || !exists
    || (resumeRef !== null && resumeRef !== undefined && worktreeHead !== resumeRef);
}

/**
 * The per-(issue, sample) identity every physical resource derives from — branch
 * `agent/<key>`, tmux session `ao-<key>`, worktree `.harness/worktrees/<key>`. Exported so
 * the guard can pin its injectivity over distinct (issueId, sampleIndex) pairs (gate pin
 * ISSUE-0019): issues driven CONCURRENTLY (FEAT-008) must never collide on a workspace or
 * session name — uniqueness here is what makes the parallel substrate collision-free.
 */
export function sampleKey(issueId: string, sampleIndex: number): string {
  return `${issueId.toLowerCase()}-s${sampleIndex}`;
}

export async function runGeneratorSession(
  config: HarnessConfig,
  input: GeneratorSessionInput,
  harnessRoot: string = process.cwd(),
  log: (m: string) => void = () => {},
): Promise<SessionResult> {
  const target = config.target;
  if (!target) throw new Error('runGeneratorSession requires config.target (a real repo).');

  const repoAbs = path.resolve(harnessRoot, target.repo);
  const baseRef = target.baseRef ?? 'HEAD';
  const key = sampleKey(input.issue.id, input.sampleIndex);
  const branch = `agent/${key}`;
  const session = `ao-${key}`;
  const route = resolveAgentRoute(config, 'generator');
  const provider = route.provider;
  const wt = path.join(harnessRoot, '.harness', 'worktrees', key);

  // Reuse only a repair worktree that still matches the durable current PR head.
  // A daemon restart may leave an older AgentOps worktree behind; reusing it
  // would force-push a repair that silently discards newer PR revisions.
  const exists = worktreeExists(wt);
  const worktreeHead = exists ? headCommit(wt) : null;
  if (generatorWorktreeRequiresReset(
    input.attempt,
    exists,
    worktreeHead,
    input.resumeRef,
  )) {
    // A repository-discovered PR is already an implementation: its first AgentOps
    // generator turn is a repair and must start from the observed PR head, not main.
    createWorktree(repoAbs, generatorStartRef(input.resumeRef, baseRef), wt);
  }

  // the full prompt lives in a file — send-keys can't carry multi-line text without
  // submitting early — and the agent reads it (Read is in allowedTools)
  const agentDir = path.join(wt, '.agentops');
  fs.mkdirSync(agentDir, { recursive: true });
  // scoped context (ARCH-execution-007): resolve the issue's dependsOnSystem from the target's
  // system views when configured — id references resolved fresh, never a dumped design (P5).
  const scoped = target.systemDir
    ? renderScopedContext(contextFor(input.issue, path.resolve(harnessRoot, target.systemDir)))
    : '';
  const prompt = buildGeneratorPrompt(input, target, scoped);
  fs.writeFileSync(path.join(agentDir, 'PROMPT.md'), prompt, 'utf8');
  const sentinelPath = path.join(agentDir, 'done.json');
  fs.rmSync(sentinelPath, { force: true }); // clear any stale sentinel from a prior attempt

  log(`  ▸ ${session}: launch in ${path.relative(harnessRoot, wt)}`);
  // Bash is allowed so the agent can run tests/typecheck to check its own work WITHOUT hanging on
  // an approval prompt in this detached session (a grounded run showed it stalls otherwise). The
  // harness is still the authoritative grader — self-checks don't count as evidence.
  // model override (config.models.generator): weaken the coder to exercise the repair loop, or
  // leave undefined to inherit the user's default model.
  launchSession({ provider, purpose: 'generator', session, cwd: wt, model: route.model ?? undefined });
  const kickoff = await submitPromptWhenSessionReady(
    session,
    provider,
    'Read .agentops/PROMPT.md and do exactly what it says, editing files directly. ' +
      'When finished, create .agentops/done.json containing {"done": true}.',
  );
  if (kickoff.readiness === 'timeout') {
    log(`  ⚠ ${session}: provider did not become ready — session + worktree kept alive`);
  } else if (!kickoff.submitted) {
    log(`  ⚠ ${session}: prompt may not have submitted — liveness monitor will surface it if stuck`);
  }

  const outcome = kickoff.readiness === 'timeout'
    ? 'stuck'
    : await monitorLiveness(session, sentinelPath, GENERATOR_LIVENESS);
  const paneTail = capturePane(session).split('\n').filter(Boolean).slice(-25).join('\n');

  // Only a clean completion tears the session down; a stuck/timed-out session is kept ALIVE
  // so a human can attach and take over (ARCH-execution-014). Never a silent kill.
  let committed = false;
  if (outcome === 'completed') {
    // Commit the edits into a single build commit (amended across repair attempts) so the branch
    // is pushable (the gate) and each read-only review can check out the exact build in isolation.
    committed = commitBuild(wt, `${input.issue.id} s${input.sampleIndex} attempt ${input.attempt}`);
    killSession(session);
    log(`  ▸ ${session}: completed (sentinel)${committed ? ', build committed' : ', no changes to commit'}`);
  } else {
    log(`  ⚠ ${session}: ${outcome.toUpperCase()} — session kept alive; inspect: tmux attach -t ${session}`);
  }

  // The build's cumulative change set comes from the commit once there is one; fall back to the
  // working tree for a stuck/empty session (nothing committed).
  const changed = committed ? buildChangedFiles(wt) : changedFiles(wt);
  const headSha = committed ? headCommit(wt) : null;
  return {
    provider,
    model: route.model,
    worktree: wt,
    branch,
    session,
    outcome,
    changed,
    headSha,
    paneTail,
    prompt,
  };
}

/**
 * Build the file the generator session reads (.agentops/PROMPT.md). Exported so the deterministic
 * seam — that a repair attempt's required fixes land in the prompt — is unit-testable without a
 * live session. On attempt 1 (no brief) it is the plain implement-the-contract briefing; on a
 * repair attempt it appends the reviewers' required fixes so the session amends the reused
 * worktree instead of starting over (live repair, ADR-0006 E7 / AC-REPAIR-001).
 */
export function buildGeneratorPrompt(input: GeneratorSessionInput, target: TargetRepoConfig, scopedContext = ''): string {
  const role = loadRolePrompt('generator');
  const contractYaml = YAML.stringify(input.contract);
  const protectedList = (target.protectedPaths ?? []).map((p) => `- ${p}`).join('\n') || '(none)';
  const sections = [
    role,
    `\n## You are in a real git checkout`,
    `Implement the Issue Contract below by EDITING FILES directly in this working directory.`,
    `Stay within scope.include. Do NOT edit these harness-owned paths (they are the grader):`,
    protectedList,
    // The wiring-pin convention (AC-PIN-001) lives in agents/generator.md next to its
    // declared-equal TDD protocol (folded there by the ⑬ release closure — the build's own
    // scope confined it to src/**+test/** and it left the move to the harness owner).
    `\n## Issue\n${input.issue.id} — ${input.issue.title} (area: ${input.issue.area})`,
    `\n## Issue Contract\n\`\`\`yaml\n${contractYaml}\`\`\``,
  ];

  if (input.issue.uiDesign) {
    sections.push(`\n## UI Design Contract\n\`\`\`yaml\n${YAML.stringify(input.issue.uiDesign)}\`\`\``);
  }
  if (input.issue.designAuthority) {
    sections.push(`\n${renderAuthoritativeDesignContext(
      input.issue.designAuthority,
      input.issue.designReview,
    )}`);
  }

  // scoped design context (ARCH-execution-007): the system elements this issue depends on, when resolved
  if (scopedContext) sections.push(`\n${scopedContext}`);

  const brief = input.repairBrief;
  if (brief && brief.instructions.length > 0) {
    sections.push(
      `\n## Repair — reviewers requested changes to your previous attempt`,
      `Your earlier edits are already in this working tree. Do NOT start over: apply these required`,
      `fixes on top of them, and do not regress acceptance criteria that already pass.`,
      `\n### Required fixes`,
      ...brief.instructions.map((i) => `- ${i}`),
    );
    if (brief.findings.length > 0) {
      sections.push(
        `\n### Findings (for context)`,
        ...brief.findings.map((f) => `- [${f.criterionId}] (${f.severity}) expected: ${f.expected || '—'}; observed: ${f.observed || '—'}`),
      );
    }
  }

  sections.push(
    `\n## Done`,
    `When the implementation is complete and you believe the tests will pass, create`,
    `.agentops/done.json containing {"done": true}. The harness grades your checkout by`,
    `running the real test suite — do not self-report pass/fail.`,
  );
  return sections.join('\n');
}
