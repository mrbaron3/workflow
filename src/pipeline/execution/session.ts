/**
 * One generator role-session (ARCH-execution-003 + 004 + 005).
 *
 * Ties the pieces the smoke test validated into a single call: fresh worktree → launch an
 * interactive Claude session in tmux → drive it with a one-line kickoff that points at a
 * prompt FILE (send-keys can't carry multi-line text) → wait for the sentinel → capture
 * pane for evidence → tear the session down. Returns what the checkout looks like; grading
 * is a separate, deterministic step.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as YAML from 'yaml';
import type { Issue, IssueContract } from '../../domain/schema.js';
import type { HarnessConfig, TargetRepoConfig } from '../../config.js';
import type { RepairBrief } from '../../domain/artifact.js';
import { loadRolePrompt } from '../../agents/prompts.js';
import { createWorktree, worktreeExists, changedFiles, commitBuild, buildChangedFiles } from './worktree.js';
import { launchSession, sendPrompt, capturePane, killSession, monitorLiveness, type LivenessOutcome } from './tmux.js';
import { contextFor, renderScopedContext } from './scoped-context.js';

export interface GeneratorSessionInput {
  issue: Issue;
  contract: IssueContract;
  sampleIndex: number;
  attempt: number;
  /** Present on repair attempts (attempt > 1): the reviewers' required fixes to apply on top. */
  repairBrief?: RepairBrief | null;
}

export interface SessionResult {
  worktree: string;
  branch: string;
  session: string;
  outcome: LivenessOutcome;
  changed: string[];
  paneTail: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll the pane until the interactive session is ready to accept input (footer marker). */
async function waitForReady(session: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (/accept edits on|❯/.test(capturePane(session))) return;
    await sleep(500);
  }
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
  const key = `${input.issue.id.toLowerCase()}-s${input.sampleIndex}`;
  const branch = `agent/${key}`;
  const session = `ao-${key}`;
  const wt = path.join(harnessRoot, '.harness', 'worktrees', key);

  // fresh worktree on the first attempt; reuse it for repair attempts so edits accumulate
  if (input.attempt === 1 || !worktreeExists(wt)) createWorktree(repoAbs, branch, baseRef, wt);

  // the full prompt lives in a file — send-keys can't carry multi-line text without
  // submitting early — and the agent reads it (Read is in allowedTools)
  const agentDir = path.join(wt, '.agentops');
  fs.mkdirSync(agentDir, { recursive: true });
  // scoped context (ARCH-execution-007): resolve the issue's dependsOnSystem from the target's
  // system views when configured — id references resolved fresh, never a dumped design (P5).
  const scoped = target.systemDir
    ? renderScopedContext(contextFor(input.issue, path.resolve(harnessRoot, target.systemDir)))
    : '';
  fs.writeFileSync(path.join(agentDir, 'PROMPT.md'), buildGeneratorPrompt(input, target, scoped), 'utf8');
  const sentinelPath = path.join(agentDir, 'done.json');
  fs.rmSync(sentinelPath, { force: true }); // clear any stale sentinel from a prior attempt

  log(`  ▸ ${session}: launch in ${path.relative(harnessRoot, wt)}`);
  // Bash is allowed so the agent can run tests/typecheck to check its own work WITHOUT hanging on
  // an approval prompt in this detached session (a grounded run showed it stalls otherwise). The
  // harness is still the authoritative grader — self-checks don't count as evidence.
  launchSession({ session, cwd: wt, allowedTools: ['Read', 'Edit', 'Write', 'Bash'], permissionMode: 'acceptEdits' });
  await waitForReady(session, 20_000);
  sendPrompt(
    session,
    'Read .agentops/PROMPT.md and do exactly what it says, editing files directly. ' +
      'When finished, create .agentops/done.json containing {"done": true}.',
  );

  const outcome = await monitorLiveness(session, sentinelPath, {
    idleMs: 90_000, // pane unchanged this long with no sentinel = stuck
    hardCapMs: 1000 * 60 * 20,
    pollMs: 3000,
  });
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
  return { worktree: wt, branch, session, outcome, changed, paneTail };
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
    `\n## Issue\n${input.issue.id} — ${input.issue.title} (area: ${input.issue.area})`,
    `\n## Issue Contract\n\`\`\`yaml\n${contractYaml}\`\`\``,
  ];

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
