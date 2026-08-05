/**
 * Sign-time git I/O for the authoring layer (M20 + D4 AC-TROOT-002/003/005): resolve committed-
 * blob git facts from whichever repo the requirement dir is rooted in — the harness's own repo,
 * or an external D4 target (`resolveTargetRoot`, ../config.js) — and persist the ApprovedSpecRef.
 * `./sign.js` stays pure (git facts are passed in); this module is the impure half that shells
 * out to git and touches the store, so `cmdSign` (cli/index.ts) is a thin print-the-result
 * wrapper around it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseSpecScenarios, parseAcceptance, parseDependsOn } from './source.js';
import { buildApprovedSpecRef } from './sign.js';
import { lintAuthoring } from './lint.js';
import { requirementsDocPath } from './spec-doc.js';
import { nowISO, type Store } from '../store/store.js';
import type { SpecState } from '../domain/schema.js';

export interface SignRequirementDirOptions {
  /** The repo root git facts are pinned against — config.ts's resolveTargetRoot(config, harnessRoot). */
  gitRoot: string;
  now?: () => string;
}

export type SignResult =
  | { ok: true; specState: SpecState }
  | { ok: false; reason: 'missing-files' }
  | { ok: false; reason: 'lint-failed'; errors: string[] }
  | { ok: false; reason: 'dirty'; porcelain: string };

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Posix, repo-root-relative pathspec for `abs` inside the repo rooted at `gitRoot`. */
function repoRel(gitRoot: string, abs: string): string {
  return path.relative(gitRoot, abs).split(path.sep).join('/');
}

/**
 * Sign a requirement dir: AUTH-B lint, then pin committed-blob git facts read from `opts.gitRoot`
 * (the harness's own repo, or an external D4 target) and persist the ApprovedSpecRef. Rejects —
 * and mutates nothing — on missing files, a failing lint, or uncommitted changes: a signature
 * only ever pins committed content (AC-AUTH-007 / AC-TROOT-002/003), in whichever repo it lives.
 */
export function signRequirementDir(store: Store, dir: string, opts: SignRequirementDirOptions): SignResult {
  const specAbs = requirementsDocPath(path.resolve(store.root, dir));
  const accAbs = path.resolve(store.root, dir, 'acceptance.yaml');
  if (!fs.existsSync(specAbs) || !fs.existsSync(accAbs)) return { ok: false, reason: 'missing-files' };

  const accText = fs.readFileSync(accAbs, 'utf8');
  const scenarios = parseSpecScenarios(fs.readFileSync(specAbs, 'utf8'));
  const verifications = parseAcceptance(accText);
  const systemRefs = parseDependsOn(accText); // pin dependsOn into ApprovedSpecRef.systemRefs

  // 1. AUTH-B gate must pass before a signature can be taken (AUTH-C precondition).
  const lint = lintAuthoring({
    specAcIds: scenarios.map((s) => s.id),
    acceptanceAcIds: Object.keys(verifications),
    methodsById: Object.fromEntries(Object.entries(verifications).map(([id, v]) => [id, v.method])),
  });
  if (!lint.ok) return { ok: false, reason: 'lint-failed', errors: lint.errors };

  // 2. Signature pins committed HEAD blobs of whichever repo actually owns this dir
  // (AC-AUTH-007 / AC-TROOT-002): the files must be clean there.
  const specRel = repoRel(opts.gitRoot, specAbs);
  const accRel = repoRel(opts.gitRoot, accAbs);
  const dirty = git(['status', '--porcelain', '--', specRel, accRel], opts.gitRoot).trim();
  if (dirty) return { ok: false, reason: 'dirty', porcelain: dirty };

  const facts = {
    signedCommitSha: git(['rev-parse', 'HEAD'], opts.gitRoot).trim(),
    specBlobGitSha: git(['rev-parse', `HEAD:${specRel}`], opts.gitRoot).trim(),
    acceptanceBlobGitSha: git(['rev-parse', `HEAD:${accRel}`], opts.gitRoot).trim(),
  };

  // 3. Build + persist the ApprovedSpecRef. status derives, it is never written.
  const approved = buildApprovedSpecRef({ scenarios, verifications, git: facts, systemRefs });
  const now = (opts.now ?? nowISO)();
  const existing = store.getSpecState(dir);
  const specState: SpecState = {
    path: dir,
    featureId: existing?.featureId ?? null, // preserve the planning-tree link across signing (AC-PLAN-008)
    approved,
    signedAt: now,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  store.upsertSpecState(specState);
  return { ok: true, specState };
}
