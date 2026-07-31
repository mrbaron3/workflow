/**
 * The committed-build isolation primitives (item 4 foundation): commitBuild folds the generator's
 * edits into a single amended build commit, buildChangedFiles reads the cumulative change set vs
 * the fork point across repair attempts, and createDetachedWorktree gives each read-only review its
 * own checkout of that build. Real git in a temp repo — the deterministic seam the parallel panel
 * and the GitHub-gate push both stand on.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  createWorktree,
  createDetachedWorktree,
  commitBuild,
  buildChangedFiles,
  changedFiles,
  headCommit,
} from '../src/pipeline/execution/worktree.js';
import { prHeadRefspec } from '../src/pipeline/execution/gate.js';

function tmpRepo(name: string): string {
  const dir = path.join(os.tmpdir(), 'agentops-test', `${name}-${process.pid}-${Math.floor(performance.now())}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'greet.ts'), 'export const g = 1;');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  return dir;
}

const write = (wt: string, rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
  fs.writeFileSync(path.join(wt, rel), body);
};

describe('commitBuild + buildChangedFiles: the build is one amended commit vs its fork point', () => {
  it('first attempt: commits the edits and reports them, excluding .agentops', () => {
    const repo = tmpRepo('bc-first');
    const wt = path.join(repo, '.wt');
    createWorktree(repo, 'HEAD', wt);
    write(wt, 'src/roman.ts', 'export const x = 1;');
    write(wt, '.agentops/PROMPT.md', 'prompt'); // harness scaffolding — must not be committed/reported

    expect(commitBuild(wt, 'ISSUE-1 attempt 1')).toBe(true);
    expect(buildChangedFiles(wt)).toEqual(['src/roman.ts']);
    // .agentops stays out of git entirely (excluded), so the tree is clean after committing
    expect(changedFiles(wt).filter((f) => !f.startsWith('.agentops'))).toEqual([]);
  });

  it('repair attempt: amend keeps ONE commit so the change set is cumulative, not just the delta', () => {
    const repo = tmpRepo('bc-repair');
    const wt = path.join(repo, '.wt');
    createWorktree(repo, 'HEAD', wt);
    write(wt, 'src/roman.ts', 'export const x = 1;');
    commitBuild(wt, 'attempt 1');
    const headAfter1 = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    // repair: touch a second file and re-commit
    write(wt, 'src/roman.ts', 'export const x = 2;');
    write(wt, 'src/util.ts', 'export const u = 1;');
    commitBuild(wt, 'attempt 2');

    // still a single build commit (amended), so HEAD^ is still base
    expect(buildChangedFiles(wt).sort()).toEqual(['src/roman.ts', 'src/util.ts']);
    const parent = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim();
    const base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(parent).toBe(base); // one commit above base, not two
    expect(execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).not.toBe(headAfter1);
  });

  it('an empty build (no edits) does not create a commit', () => {
    const repo = tmpRepo('bc-empty');
    const wt = path.join(repo, '.wt');
    createWorktree(repo, 'HEAD', wt);
    expect(commitBuild(wt, 'nothing')).toBe(false);
  });
});

describe('createWorktree: stable PR branch isolation', () => {
  it('keeps a retained branch checkout intact while a new detached job publishes its HEAD', () => {
    const repo = tmpRepo('wt-retained-branch');
    const retained = path.join(repo, '.retained');
    execFileSync(
      'git',
      ['-C', repo, 'worktree', 'add', '-b', 'agent/x', retained, 'HEAD'],
      { stdio: 'ignore' },
    );
    const retainedHead = execFileSync(
      'git',
      ['-C', repo, 'rev-parse', 'refs/heads/agent/x'],
      { encoding: 'utf8' },
    ).trim();

    const wt = path.join(repo, '.next-job');
    expect(() => createWorktree(repo, 'HEAD', wt)).not.toThrow();
    expect(execFileSync(
      'git',
      ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf8' },
    ).trim()).toBe('HEAD');

    write(wt, 'src/next.ts', 'export const next = true;');
    expect(commitBuild(wt, 'next job')).toBe(true);
    const nextHead = headCommit(wt);
    const remote = `${repo}-remote.git`;
    fs.rmSync(remote, { recursive: true, force: true });
    execFileSync('git', ['init', '-q', '--bare', remote]);
    execFileSync('git', ['-C', wt, 'remote', 'add', 'probe', remote]);
    execFileSync(
      'git',
      ['-C', wt, 'push', '-u', 'probe', prHeadRefspec('agent/x')],
      { stdio: 'ignore' },
    );

    expect(execFileSync(
      'git',
      ['--git-dir', remote, 'rev-parse', 'refs/heads/agent/x'],
      { encoding: 'utf8' },
    ).trim()).toBe(nextHead);
    expect(execFileSync(
      'git',
      ['-C', retained, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf8' },
    ).trim()).toBe('agent/x');
    expect(execFileSync(
      'git',
      ['-C', repo, 'rev-parse', 'refs/heads/agent/x'],
      { encoding: 'utf8' },
    ).trim()).toBe(retainedHead);
  });
});

describe('createDetachedWorktree: each review checks out the committed build in isolation', () => {
  it('the review worktree has the build, and an edit there is detected but never touches the build', () => {
    const repo = tmpRepo('dw');
    const wt = path.join(repo, '.wt');
    createWorktree(repo, 'HEAD', wt);
    write(wt, 'src/roman.ts', 'export const x = 1;');
    commitBuild(wt, 'attempt 1');

    const review = path.join(repo, '.review');
    createDetachedWorktree(repo, headCommit(wt), review);
    // fresh checkout of the build: clean tree, build file present
    expect(changedFiles(review)).toEqual([]);
    expect(fs.readFileSync(path.join(review, 'src', 'roman.ts'), 'utf8')).toContain('export const x = 1');

    // a review that edits its own worktree is attributable (its tree is dirty) and the build (the
    // generator worktree) is unaffected
    write(review, 'src/roman.ts', 'HACKED');
    expect(changedFiles(review)).toContain('src/roman.ts');
    expect(fs.readFileSync(path.join(wt, 'src', 'roman.ts'), 'utf8')).toContain('export const x = 1');
  });

  it('is idempotent against a STALE leftover directory git no longer tracks (kept-alive stuck review)', () => {
    const repo = tmpRepo('dw-stale');
    const wt = path.join(repo, '.wt');
    createWorktree(repo, 'HEAD', wt);
    write(wt, 'src/roman.ts', 'export const x = 1;');
    commitBuild(wt, 'attempt 1');

    const review = path.join(repo, '.review');
    createDetachedWorktree(repo, headCommit(wt), review);
    // simulate a re-scaffold: a leftover dir with content that git no longer knows about
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', review]);
    fs.mkdirSync(review, { recursive: true });
    fs.writeFileSync(path.join(review, 'stale.txt'), 'leftover from a prior stuck review');

    // must not throw "already exists" — clears the stale dir first
    expect(() => createDetachedWorktree(repo, headCommit(wt), review)).not.toThrow();
    expect(fs.existsSync(path.join(review, 'stale.txt'))).toBe(false); // stale content gone
    expect(fs.readFileSync(path.join(review, 'src', 'roman.ts'), 'utf8')).toContain('export const x = 1');
  });
});
