/**
 * FEAT-012 / D6 — reviewer workspaces are disposable build snapshots while prompts and
 * findings live in a separate sidecar. Dependency-tool lockfile churn is observable but
 * does not erase a valid review; source/config edits still fail closed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectFindings,
  findingsPath,
  partitionReviewChanges,
  reviewJobPaths,
  type ReviewJob,
} from '../src/pipeline/execution/perspective-session.js';

const roots: string[] = [];
function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-review-integrity-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function jobWithFindings(root: string, issueKey: string, perspective: string): ReviewJob {
  const job = reviewJobPaths(
    path.join(root, 'review-worktrees'),
    path.join(root, 'review-evidence'),
    issueKey,
    perspective,
  );
  fs.mkdirSync(job.reviewWt, { recursive: true });
  fs.mkdirSync(path.dirname(job.sentinel), { recursive: true });
  fs.writeFileSync(job.sentinel, JSON.stringify({ verdict: 'approve', findings: [] }), 'utf8');
  return job;
}

describe('review workspace / evidence sidecar boundary', () => {
  it('AC-REVWS-001/AC-REVWS-002 gives every lens a detached-workspace path and an external evidence sidecar', () => {
    const root = tmpRoot();
    const job = reviewJobPaths(
      path.join(root, 'review-worktrees'),
      path.join(root, 'review-evidence'),
      'issue-42-s0',
      'security',
    );

    expect(path.relative(job.reviewWt, job.prompt).startsWith('..')).toBe(true);
    expect(path.relative(job.reviewWt, job.sentinel).startsWith('..')).toBe(true);
    expect(path.dirname(job.prompt)).toBe(path.dirname(job.sentinel));
    expect(job.reviewWt).not.toBe(root); // never the generator/harness root
  });

  it('AC-REVWS-003 keeps valid findings when dependency inspection dirties only known lockfiles', () => {
    const root = tmpRoot();
    const job = jobWithFindings(root, 'issue-42-s0', 'testQuality');
    const evalRoot = path.join(root, 'central-eval');
    const logs: string[] = [];

    const result = collectFindings([job], ['completed'], evalRoot, {
      changed: () => ['packages/web/pnpm-lock.yaml', 'package-lock.json'],
      log: (message) => logs.push(message),
    });

    expect(result.completed).toEqual(['testQuality']);
    expect(result.touchedCode).toEqual([]);
    expect(result.environmentChanges).toEqual({
      testQuality: ['package-lock.json', 'packages/web/pnpm-lock.yaml'],
    });
    expect(fs.existsSync(findingsPath(evalRoot, 'testQuality'))).toBe(true);
    expect(logs.join('\n')).toContain('environment artifacts');
  });

  it('AC-REVWS-004 rejects a source-changing review without affecting a clean peer', () => {
    const root = tmpRoot();
    const dirty = jobWithFindings(root, 'issue-42-s0', 'security');
    const clean = jobWithFindings(root, 'issue-42-s0', 'accessibility');
    const evalRoot = path.join(root, 'central-eval');

    const result = collectFindings([dirty, clean], ['completed', 'completed'], evalRoot, {
      changed: (worktree) => (worktree === dirty.reviewWt ? ['src/auth.ts'] : []),
    });

    expect(result.touchedCode).toEqual(['security']);
    expect(result.completed).toEqual(['accessibility']);
    expect(fs.existsSync(findingsPath(evalRoot, 'security'))).toBe(false);
    expect(fs.existsSync(findingsPath(evalRoot, 'accessibility'))).toBe(true);
  });

  it('AC-REVWS-005 classifies unknown or mixed mutations as source changes, deterministically', () => {
    const first = partitionReviewChanges(['package-lock.json', 'tmp/reviewer-note.txt', 'src/x.ts']);
    const reordered = partitionReviewChanges(['src/x.ts', 'package-lock.json', 'tmp/reviewer-note.txt']);

    expect(first).toEqual(reordered);
    expect(first.environmentArtifacts).toEqual(['package-lock.json']);
    expect(first.sourceChanges).toEqual(['src/x.ts', 'tmp/reviewer-note.txt']);
  });

  it('AC-REVWS-006 keeps issue/lens sidecars collision-free and collects late evidence', () => {
    const root = tmpRoot();
    const first = jobWithFindings(root, 'issue-42-s0', 'ux');
    const second = jobWithFindings(root, 'issue-43-s0', 'ux');
    const third = jobWithFindings(root, 'issue-42-s0', 'security');

    expect(new Set([first.sentinel, second.sentinel, third.sentinel]).size).toBe(3);

    const evalRoot = path.join(root, 'central-eval');
    const result = collectFindings([first], ['timeout'], evalRoot, { changed: () => [] });
    expect(result.completed).toEqual(['ux']);
    expect(fs.existsSync(findingsPath(evalRoot, 'ux'))).toBe(true);
  });
});
