/**
 * Git worktree isolation (ARCH-execution-004, realising LANG-execution-007).
 *
 * Each sample gets its own git worktree of the target repo, so a session edits real files
 * in isolation and the harness can diff / grade that checkout. Repair attempts reuse the
 * same worktree so fixes accumulate. Worktrees are ephemeral (DOM-execution-002): the
 * durable footprint is the PR/Issue status in the store.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(cwd: string, args: string[], allowFail = false): { ok: boolean; out: string } {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (!allowFail && res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out}`);
  return { ok: res.status === 0, out };
}

/**
 * Create a fresh worktree at `worktreePath` on branch `branch`, forked from `baseRef`.
 * Idempotent: tears down any stale worktree/branch of the same name first.
 */
export function createWorktree(repo: string, branch: string, baseRef: string, worktreePath: string): void {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(repo, ['worktree', 'remove', '--force', worktreePath], true);
  git(repo, ['branch', '-D', branch], true);
  git(repo, ['worktree', 'add', '-B', branch, worktreePath, baseRef]);
}

export function worktreeExists(worktreePath: string): boolean {
  return fs.existsSync(worktreePath);
}

/** Files changed in the worktree (tracked + untracked), for filesChanged / scope checks.
 *  Excludes `.agentops/` — the harness's own prompt/sentinel scaffolding, which is
 *  infrastructure the harness writes into every worktree, never the agent's edits.
 *  (First real run caught this: without the exclusion, .agentops/ read as scope creep.) */
export function changedFiles(worktreePath: string): string[] {
  const { out } = git(worktreePath, ['status', '--porcelain'], true);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\S+\s+/, '').replace(/^.*->\s*/, '')) // strip status code / rename arrow
    .filter((f) => f !== '.agentops' && !f.startsWith('.agentops/'));
}

export function removeWorktree(repo: string, worktreePath: string): void {
  git(repo, ['worktree', 'remove', '--force', worktreePath], true);
}
