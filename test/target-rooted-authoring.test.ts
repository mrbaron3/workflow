/**
 * D4 — target-rooted authoring (docs/requirements/target-rooted-authoring, AC-TROOT-001..005):
 * spawn-specs / sign / spawn-issues / contract-draft work against an EXTERNAL target repo's docs
 * tree and git, not just the harness's own. The org store (Store / db.json) never moves — only
 * the WHAT it decomposes lives out there (ADR-0001: no second store in the target).
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store/store.js';
import { DEFAULT_CONFIG, resolveTargetRoot, type HarnessConfig } from '../src/config.js';
import { planRoadmap, spawnSpecs, spawnIssues } from '../src/planning/planning-tree.js';
import { draftContracts } from '../src/pipeline/contract-draft.js';
import { signRequirementDir } from '../src/authoring/sign-dir.js';

function tmpStore(name: string): Store {
  const dir = path.join(os.tmpdir(), 'agentops-test', `troot-store-${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return new Store(dir);
}

/** A real, throwaway git repo standing in for an external D4 target (e.g. channel-compass). */
function tmpTargetRepo(name: string): string {
  const dir = path.join(os.tmpdir(), 'agentops-test', `troot-target-${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# target\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  return dir;
}

function commitAll(repo: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: repo, stdio: 'ignore' });
}

function gitRevParse(repo: string, ref: string): string {
  return execFileSync('git', ['rev-parse', ref], { cwd: repo, encoding: 'utf8' }).trim();
}

function roadmap(): unknown {
  return {
    vision: 'A theme repo owning its own WHAT.',
    epics: [
      {
        id: 'EPIC-01',
        title: 'Theme core',
        theme: 'theme',
        outcome: 'The theme repo self-describes.',
        features: [{ id: 'FEAT-001', title: 'First analysis pass', outcome: 'A first grounded pass exists.' }],
      },
    ],
  };
}

/** Author a minimal signable spec (one AC) directly into an already-spawned spec dir. */
function authorRequirementDir(specAbs: string): void {
  fs.writeFileSync(
    path.join(specAbs, 'requirements.md'),
    '# Requirements\n\n## 受け入れ基準\n- **[AC-Y01-001] the behavior**\n  - Given x\n  - When y\n  - Then z\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(specAbs, 'acceptance.yaml'),
    'verifications:\n  AC-Y01-001:\n    severity: blocker\n    method: unit_test\n    expected: ["x"]\n',
    'utf8',
  );
}

describe('D4 target-rooted authoring', () => {
  it('AC-TROOT-001: spawn-specs materializes the stub in the external target repo, tracked and idempotent', () => {
    const store = tmpStore('ac-troot-001');
    const target = tmpTargetRepo('ac-troot-001');
    const config: HarnessConfig = { ...DEFAULT_CONFIG, target: { repo: target } };
    const targetRoot = resolveTargetRoot(config, store.root);
    expect(targetRoot).toBe(target); // rooted at config.target, not at the org store

    planRoadmap(store, roadmap());
    const res = spawnSpecs(store, { specsRoot: path.join(targetRoot, 'docs', 'requirements') });

    expect(res.spawned).toBe(1);
    const feature = store.getFeature('FEAT-001')!;
    expect(feature.specPath).not.toBeNull();

    // it landed in the EXTERNAL repo's docs tree, not under the org store's root.
    const specAbs = path.resolve(store.root, feature.specPath!);
    expect(specAbs.startsWith(target)).toBe(true);
    expect(fs.existsSync(path.join(specAbs, 'requirements.md'))).toBe(true);
    expect(fs.existsSync(path.join(specAbs, 'acceptance.yaml'))).toBe(true);

    // bidirectional link, exactly like self-rooted authoring.
    const st = store.getSpecState(feature.specPath!)!;
    expect(st.featureId).toBe('FEAT-001');
    expect(st.approved).toBeNull();

    // idempotent + non-destructive re-run: no duplicate, authored content preserved.
    const specFile = path.join(specAbs, 'requirements.md');
    const authored = fs.readFileSync(specFile, 'utf8') + '\n## Authored\n- **[AC-Y01-001] x**\n';
    fs.writeFileSync(specFile, authored, 'utf8');
    const res2 = spawnSpecs(store, { specsRoot: path.join(targetRoot, 'docs', 'requirements') });
    expect(res2.spawned).toBe(0);
    expect(store.db.specStates).toHaveLength(1);
    expect(fs.readFileSync(specFile, 'utf8')).toBe(authored);

    // the org store itself never duplicates into the target (ADR-0001).
    expect(fs.existsSync(path.join(target, '.harness'))).toBe(false);
  });

  it('AC-TROOT-002: sign pins committed blobs of the external repo\'s git', () => {
    const store = tmpStore('ac-troot-002');
    const target = tmpTargetRepo('ac-troot-002');
    const config: HarnessConfig = { ...DEFAULT_CONFIG, target: { repo: target } };
    const targetRoot = resolveTargetRoot(config, store.root);

    planRoadmap(store, roadmap());
    spawnSpecs(store, { specsRoot: path.join(targetRoot, 'docs', 'requirements') });
    const feature = store.getFeature('FEAT-001')!;
    const specDir = feature.specPath!; // store.root-relative, escapes (../) out to `target`
    const specAbs = path.resolve(store.root, specDir);

    authorRequirementDir(specAbs);
    commitAll(target, 'author FEAT-001');

    const result = signRequirementDir(store, specDir, { gitRoot: targetRoot });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const approved = result.specState.approved!;

    // the pinned facts are the EXTERNAL repo's git, not the harness's own.
    const specRelInTarget = path.relative(targetRoot, path.join(specAbs, 'requirements.md')).split(path.sep).join('/');
    const accRelInTarget = path.relative(targetRoot, path.join(specAbs, 'acceptance.yaml')).split(path.sep).join('/');
    expect(approved.signedCommitSha).toBe(gitRevParse(target, 'HEAD'));
    expect(approved.specBlobGitSha).toBe(gitRevParse(target, `HEAD:${specRelInTarget}`));
    expect(approved.acceptanceBlobGitSha).toBe(gitRevParse(target, `HEAD:${accRelInTarget}`));
    expect(approved.approvedAcIds).toEqual(['AC-Y01-001']);

    // a subsequent uncommitted edit in the EXTERNAL repo is what the dirty-reject (AC-TROOT-003)
    // guards against — confirm the coarse blob really did move on disk there.
    fs.appendFileSync(path.join(specAbs, 'requirements.md'), '\n<!-- edited -->\n');
    const changed = execFileSync('git', ['status', '--porcelain'], { cwd: target, encoding: 'utf8' });
    expect(changed).not.toBe('');
  });

  it('AC-TROOT-003: uncommitted changes in the external repo reject the signature and leave SpecState untouched', () => {
    const store = tmpStore('ac-troot-003');
    const target = tmpTargetRepo('ac-troot-003');
    const config: HarnessConfig = { ...DEFAULT_CONFIG, target: { repo: target } };
    const targetRoot = resolveTargetRoot(config, store.root);

    planRoadmap(store, roadmap());
    spawnSpecs(store, { specsRoot: path.join(targetRoot, 'docs', 'requirements') });
    const feature = store.getFeature('FEAT-001')!;
    const specDir = feature.specPath!;
    const specAbs = path.resolve(store.root, specDir);
    authorRequirementDir(specAbs); // deliberately NOT committed

    const before = store.getSpecState(specDir);
    const result = signRequirementDir(store, specDir, { gitRoot: targetRoot });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('dirty');
    const after = store.getSpecState(specDir);
    expect(after?.approved ?? null).toBe(before?.approved ?? null); // still unsigned
    expect(after?.updatedAt).toBe(before?.updatedAt); // untouched, not just unapproved
  });

  it('AC-TROOT-004: spawn-issues + contract-draft resolve design lint and scope against the external repo', () => {
    const store = tmpStore('ac-troot-004');
    const target = tmpTargetRepo('ac-troot-004');
    const config: HarnessConfig = { ...DEFAULT_CONFIG, target: { repo: target } };
    const targetRoot = resolveTargetRoot(config, store.root);

    planRoadmap(store, roadmap());
    spawnSpecs(store, { specsRoot: path.join(targetRoot, 'docs', 'requirements') });
    const feature = store.getFeature('FEAT-001')!;
    const specDir = feature.specPath!;
    const specAbs = path.resolve(store.root, specDir);
    authorRequirementDir(specAbs);

    // the external repo's OWN system layer — sibling of docs/requirements (docs/_system).
    const sysDir = path.join(targetRoot, 'docs', '_system', 'domain');
    fs.mkdirSync(sysDir, { recursive: true });
    fs.writeFileSync(path.join(sysDir, 'domain.md'), '# domain\n- DOM-theme-001\n', 'utf8');
    fs.writeFileSync(
      path.join(specAbs, 'issues.yaml'),
      `issues:
  - key: ISSUE-Y01-001
    title: Build the first analysis pass
    area: backend
    coversAcIds: [AC-Y01-001]
    dependsOnSystem: [DOM-theme-001]
    scope:
      include: ['src/analysis/**']
`,
      'utf8',
    );
    commitAll(target, 'author + decompose FEAT-001');

    const signed = signRequirementDir(store, specDir, { gitRoot: targetRoot });
    expect(signed.ok).toBe(true);

    const res = spawnIssues(store, specDir);
    expect(res.spawned).toBe(1); // design lint resolved DOM-theme-001 from the EXTERNAL docs/_system
    const issue = store.db.issues[0]!;
    expect(issue.dependsOnSystem).toEqual(['DOM-theme-001']);
    expect(issue.featureId).toBe('FEAT-001');

    const drafted = draftContracts(store, specDir);
    expect(drafted.drafted).toBe(1);
    const contracted = store.db.issues[0]!;
    expect(contracted.status).toBe('contract-drafted');
    expect(contracted.contract?.scope).toEqual({ include: ['src/analysis/**'], exclude: [] });

    // the org store itself never grew a second copy inside the target repo.
    expect(fs.existsSync(path.join(target, '.harness'))).toBe(false);
  });

  it('AC-TROOT-005: config.target absent or repo="." resolves to the harness root — self-authoring unchanged', () => {
    const store = tmpStore('ac-troot-005');
    expect(resolveTargetRoot(DEFAULT_CONFIG, store.root)).toBe(store.root);
    expect(resolveTargetRoot({ ...DEFAULT_CONFIG, target: { repo: '.' } }, store.root)).toBe(store.root);

    planRoadmap(store, roadmap());
    const targetRoot = resolveTargetRoot(DEFAULT_CONFIG, store.root);
    const res = spawnSpecs(store, { specsRoot: path.join(targetRoot, 'docs', 'requirements') });
    expect(res.spawned).toBe(1);
    const feature = store.getFeature('FEAT-001')!;
    // lands under the harness's own docs/requirements, exactly like the bare spawnSpecs(store) default.
    expect(feature.specPath).toBe('docs/requirements/first-analysis-pass');
  });
});
