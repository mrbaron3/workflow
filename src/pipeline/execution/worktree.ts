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
import { commandEnvironment, commandTimeoutMs } from './command.js';

function git(cwd: string, args: string[], allowFail = false): { ok: boolean; out: string } {
  const res = spawnSync('git', [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgSign=false',
    '-c', 'credential.helper=',
    ...args,
  ], {
    cwd,
    encoding: 'utf8',
    env: {
      ...commandEnvironment('none'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    timeout: commandTimeoutMs(),
    killSignal: 'SIGKILL',
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (!allowFail && (res.error || res.status !== 0)) {
    throw new Error(
      `git ${args.join(' ')} failed: ${res.error?.message ?? out}`,
    );
  }
  return { ok: res.status === 0, out };
}

/**
 * Clear any prior worktree at `worktreePath` so `worktree add` can't collide. Robust to a stale
 * dir that git doesn't know about — a review kept alive after a stuck session (ARCH-execution-014),
 * then a re-scaffold into a NEW repo where `worktree remove` no longer recognises the path. So:
 * try the clean git removal, force-delete any leftover directory, then prune the admin entry.
 */
function clearWorktree(repo: string, worktreePath: string): void {
  git(repo, ['worktree', 'remove', '--force', worktreePath], true); // if this repo still tracks it
  fs.rmSync(worktreePath, { recursive: true, force: true }); // leftover dir (foreign / untracked)
  git(repo, ['worktree', 'prune'], true); // drop the now-dangling admin entry
}

/**
 * Create a fresh worktree at `worktreePath` on branch `branch`, forked from `baseRef`.
 * Idempotent: tears down any stale worktree/branch of the same name first.
 */
export function createWorktree(repo: string, branch: string, baseRef: string, worktreePath: string): void {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  clearWorktree(repo, worktreePath);
  git(repo, ['branch', '-D', branch], true);
  git(repo, ['worktree', 'add', '-B', branch, worktreePath, baseRef]);
  excludeAgentops(worktreePath);
}

/**
 * A read-only review's checkout: detached HEAD at `commitish` (the generator's committed build).
 * Detached (not the branch) so several reviews can check out the same build concurrently without
 * git's "branch already checked out" guard, and so a review can never advance the branch.
 */
export function createDetachedWorktree(repo: string, commitish: string, worktreePath: string): void {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  clearWorktree(repo, worktreePath);
  git(repo, ['worktree', 'add', '--detach', worktreePath, commitish]);
  excludeAgentops(worktreePath);
}

export function worktreeExists(worktreePath: string): boolean {
  return fs.existsSync(worktreePath);
}

/** Keep the harness's own `.agentops/` scaffolding out of git entirely (never staged, never diffed). */
function excludeAgentops(worktreePath: string): void {
  const excludePath = git(worktreePath, ['rev-parse', '--git-path', 'info/exclude']).out.trim();
  const abs = path.isAbsolute(excludePath) ? excludePath : path.join(worktreePath, excludePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  if (!cur.includes('.agentops/')) fs.writeFileSync(abs, `${cur}${cur.endsWith('\n') || cur === '' ? '' : '\n'}.agentops/\n`, 'utf8');
}

const BUILD_MARKER = 'agentops-build:';

/** True iff the worktree's HEAD is one of our build commits (vs. sitting on the base). */
function hasBuildCommit(worktreePath: string): boolean {
  const { ok, out } = git(worktreePath, ['log', '-1', '--format=%s'], true);
  return ok && out.trim().startsWith(BUILD_MARKER);
}

/**
 * Commit the generator's edits as a SINGLE build commit on top of base: a fresh commit on the
 * first attempt, `--amend` on repair attempts so the branch always carries exactly one build
 * commit (⇒ `HEAD^` is always the fork point, see buildChangedFiles). `.agentops/` is excluded
 * (excludeAgentops). Returns false when there is nothing to commit and no prior build commit —
 * a degenerate empty build that grading will fail on its own. A committed build is what makes a
 * real `git push` (the gate) non-empty and what read-only review worktrees check out.
 */
export function commitBuild(worktreePath: string, message: string): boolean {
  git(worktreePath, ['add', '-A'], true);
  const staged = git(worktreePath, ['diff', '--cached', '--name-only'], true).out.trim();
  const amend = hasBuildCommit(worktreePath);
  if (!staged) return amend; // nothing new: a prior build commit still stands; otherwise no build
  const ident = ['-c', 'user.name=agentops', '-c', 'user.email=agentops@localhost'];
  const commit = amend
    ? ['commit', '--amend', '--no-edit', '--no-verify']
    : ['commit', '-m', `${BUILD_MARKER} ${message}`, '--no-verify'];
  git(worktreePath, [...ident, ...commit]);
  return true;
}

/**
 * The committed build's net changes vs. its fork point — `git diff --name-only HEAD^..HEAD`.
 * Because commitBuild keeps the build to one amended commit, HEAD^ is the base on every attempt,
 * so this is the CUMULATIVE change set even after repairs (not just the last attempt's delta).
 * Excludes `.agentops/`. Use this (not changedFiles) once the build is committed.
 */
export function buildChangedFiles(worktreePath: string): string[] {
  const { out } = git(worktreePath, ['diff', '--name-only', 'HEAD^', 'HEAD'], true);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((f) => f !== '.agentops' && !f.startsWith('.agentops/'));
}

/** Full immutable commit identity for the build currently checked out. */
export function headCommit(worktreePath: string): string {
  return git(worktreePath, ['rev-parse', 'HEAD']).out.trim();
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
