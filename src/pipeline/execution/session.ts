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
import { loadRolePrompt } from '../../agents/prompts.js';
import { createWorktree, worktreeExists, changedFiles } from './worktree.js';
import { launchSession, sendPrompt, capturePane, killSession, waitForSentinel } from './tmux.js';

export interface GeneratorSessionInput {
  issue: Issue;
  contract: IssueContract;
  sampleIndex: number;
  attempt: number;
}

export interface SessionResult {
  worktree: string;
  branch: string;
  session: string;
  sentinelSeen: boolean;
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
  fs.writeFileSync(path.join(agentDir, 'PROMPT.md'), buildPrompt(input, target), 'utf8');
  const sentinelPath = path.join(agentDir, 'done.json');
  fs.rmSync(sentinelPath, { force: true }); // clear any stale sentinel from a prior attempt

  log(`  ▸ ${session}: launch in ${path.relative(harnessRoot, wt)}`);
  launchSession({ session, cwd: wt, allowedTools: ['Read', 'Edit', 'Write'], permissionMode: 'acceptEdits' });
  await waitForReady(session, 20_000);
  sendPrompt(
    session,
    'Read .agentops/PROMPT.md and do exactly what it says, editing files directly. ' +
      'When finished, create .agentops/done.json containing {"done": true}.',
  );

  const sentinelSeen = await waitForSentinel(sentinelPath, { timeoutMs: 1000 * 60 * 15, pollMs: 2000 });
  const paneTail = capturePane(session).split('\n').filter(Boolean).slice(-20).join('\n');
  killSession(session);
  log(`  ▸ ${session}: ${sentinelSeen ? 'sentinel seen' : 'TIMED OUT (no sentinel)'}`);

  return { worktree: wt, branch, session, sentinelSeen, changed: changedFiles(wt), paneTail };
}

function buildPrompt(input: GeneratorSessionInput, target: TargetRepoConfig): string {
  const role = loadRolePrompt('generator');
  const contractYaml = YAML.stringify(input.contract);
  const protectedList = (target.protectedPaths ?? []).map((p) => `- ${p}`).join('\n') || '(none)';
  return [
    role,
    `\n## You are in a real git checkout`,
    `Implement the Issue Contract below by EDITING FILES directly in this working directory.`,
    `Stay within scope.include. Do NOT edit these harness-owned paths (they are the grader):`,
    protectedList,
    `\n## Issue\n${input.issue.id} — ${input.issue.title} (area: ${input.issue.area})`,
    `\n## Issue Contract\n\`\`\`yaml\n${contractYaml}\`\`\``,
    `\n## Done`,
    `When the implementation is complete and you believe the tests will pass, create`,
    `.agentops/done.json containing {"done": true}. The harness grades your checkout by`,
    `running the real test suite — do not self-report pass/fail.`,
  ].join('\n');
}
