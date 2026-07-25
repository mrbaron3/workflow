/**
 * Container-neutral path resolution + host-path guard (issue #11: 「grader / workspace / systemDir 等を
 * コンテナ内の相対／設定可能 path で解決し、Mac の /Users/... に依存させない」 and 「repository 内の
 * Mac 絶対 path 依存検査」).
 *
 * Two jobs:
 *   - `resolveContainerPaths` resolves the harness's in-container roots from env with container-absolute
 *     defaults, and fails closed if any resolved value is a macOS home path.
 *   - `scanForHostPathDependencies` statically scans the build/runtime surface (src + build config) for
 *     hardcoded macOS home paths, so a Mac-absolute dependency can never silently ship into the image.
 *
 * The forbidden marker is assembled from parts (`MAC_HOME_ROOT`) rather than written as a literal, so
 * this detector file contains no host-path substring that would trip its own scanner.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ContainerNeutralPaths } from './schema.js';

/** The macOS home tree root, assembled from parts so this source carries no literal to self-flag. */
export const MAC_HOME_ROOT = `/${'Users'}/`;

/**
 * Scanner pattern: the macOS home root followed by a real username character (a letter, digit, `_` or
 * `-`). This deliberately matches only an actual hardcoded host path, and NOT documentation that merely
 * mentions the concept with an ellipsis or a bare root — otherwise this very file, and the doc comments
 * that explain the rule, would trip the scanner. Built from `MAC_HOME_ROOT` so no literal appears here.
 */
const HOST_PATH_PATTERN = new RegExp(
  `${MAC_HOME_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[A-Za-z0-9_-]`,
);

/** In-container defaults. Every one is container-absolute and carries no Mac dependency. */
export const DEFAULT_CONTAINER_PATHS: ContainerNeutralPaths = {
  appRoot: '/app',
  workspaceRoot: '/workspace',
  storeRoot: '/data/store',
  systemDir: '/app/docs/_system',
};

const PATH_ENV_KEYS: Record<keyof ContainerNeutralPaths, string> = {
  appRoot: 'AGENTOPS_APP_ROOT',
  workspaceRoot: 'AGENTOPS_WORKSPACE_ROOT',
  storeRoot: 'AGENTOPS_STORE_ROOT',
  systemDir: 'AGENTOPS_SYSTEM_DIR',
};

/** True iff the path is rooted in the macOS home tree — the one dependency the container must never carry. */
export function isHostAbsolutePath(value: string): boolean {
  return value.startsWith(MAC_HOME_ROOT);
}

/** Thrown when a resolved runtime path, or a scanned source file, carries a macOS host dependency. */
export class HostPathDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostPathDependencyError';
  }
}

/** Fails closed if `value` is a macOS home path; otherwise returns it unchanged. */
export function assertContainerNeutralPath(value: string, label: string): string {
  if (isHostAbsolutePath(value)) {
    throw new HostPathDependencyError(
      `${label} resolves to a macOS home path (${value}); container paths must be host-neutral`,
    );
  }
  return value;
}

/**
 * Resolves the harness's in-container roots from env, falling back to container-absolute defaults.
 * Fails closed via `assertContainerNeutralPath` if any override points into the macOS home tree.
 */
export function resolveContainerPaths(env: NodeJS.ProcessEnv = process.env): ContainerNeutralPaths {
  const resolved: Record<string, string> = {};
  for (const key of Object.keys(DEFAULT_CONTAINER_PATHS) as Array<keyof ContainerNeutralPaths>) {
    const raw = env[PATH_ENV_KEYS[key]];
    const value = raw && raw.trim() !== '' ? raw.trim() : DEFAULT_CONTAINER_PATHS[key];
    resolved[key] = assertContainerNeutralPath(value, key);
  }
  return ContainerNeutralPaths.parse(resolved);
}

// --- static host-path scanner ----------------------------------------------

export interface HostPathFinding {
  /** File path, relative to the scan root. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The offending line, trimmed. */
  text: string;
}

/** Recursively collects `.ts` files under `dir`, returning paths relative to `root`. */
function collectTsFiles(root: string, dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(root, abs));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(path.relative(root, abs));
    }
  }
  return out;
}

/**
 * The build/runtime surface scanned by default: everything under `src/` plus the build config that
 * shapes the image. Docs and tests are intentionally excluded — they legitimately cite host-specific
 * example paths (e.g. an ADR quoting an operator's daemon path) and never enter the running container.
 */
export function defaultScanTargets(root: string): string[] {
  const targets = collectTsFiles(root, path.join(root, 'src'));
  for (const config of ['deploy/Containerfile', 'package.json', 'tsconfig.json']) {
    if (fs.existsSync(path.join(root, config))) targets.push(config);
  }
  return targets;
}

/**
 * Scans the given files (default: the build/runtime surface) for hardcoded macOS home paths. Returns
 * every finding so the caller can report them all at once; an empty array means the surface is clean.
 */
export function scanForHostPathDependencies(
  root: string,
  files: string[] = defaultScanTargets(root),
): HostPathFinding[] {
  const findings: HostPathFinding[] = [];
  for (const file of files) {
    const abs = path.isAbsolute(file) ? file : path.join(root, file);
    if (!fs.existsSync(abs)) continue;
    const content = fs.readFileSync(abs, 'utf8');
    for (const [index, line] of content.split('\n').entries()) {
      if (HOST_PATH_PATTERN.test(line)) {
        findings.push({ file, line: index + 1, text: line.trim() });
      }
    }
  }
  return findings;
}

/** Fail-closed form: throws `HostPathDependencyError` listing every hardcoded macOS home path found. */
export function assertNoHostPathDependencies(
  root: string,
  files?: string[],
): void {
  const findings = scanForHostPathDependencies(root, files);
  if (findings.length > 0) {
    const detail = findings.map((f) => `${f.file}:${f.line} ${f.text}`).join('\n- ');
    throw new HostPathDependencyError(`hardcoded macOS home path(s) found:\n- ${detail}`);
  }
}
