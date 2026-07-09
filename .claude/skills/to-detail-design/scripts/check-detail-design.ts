#!/usr/bin/env tsx
/**
 * Pre-spawn integrity check for a spec's issue decomposition: a thin wrapper that parses
 * the spec's issues.yaml manifest (+ spec.md AC anchors + the system layer element ids)
 * and delegates to the vendored deterministic tier in ./lib/design-lint.ts. The skill's
 * prose never re-implements these rules.
 *
 * Run from anywhere:
 *   npx tsx <skill>/scripts/check-detail-design.ts <spec-dir> [--system <dir>]
 *
 * <spec-dir> holds requirements.md (legacy: spec.md) and issues.yaml (the spawn
 * manifest). The system layer defaults to <spec-dir>/../_system, else
 * <spec-dir>/../../_system (override with --system <dir>); element ids
 * are read recursively from every *.md beneath it (context dirs included).
 * Exit: 0 = passed, 1 = lint failed, 2 = usage / read error.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { lintDesign, type IssueCore } from './lib/design-lint.js';
import { requirementsDocPath } from './lib/spec-doc.js';

const AC_RE = /\bAC-[A-Z0-9]+-\d+\b/g;
// Context-segmented system element ids: <KIND>-<ctx>-NNN (DOC_TAXONOMY §ID 体系).
const SYS_RE = /\b(?:LANG|DOM|ARCH|DATA|CONTRACT)-[a-z0-9]+(?:-[a-z0-9]+)*-\d+\b/g;
const uniq = (xs: string[]): string[] => [...new Set(xs)];

function readOrExit(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    console.error(`cannot read ${what}: ${path}`);
    process.exit(2);
  }
}

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const systemFlagIdx = args.indexOf('--system');
const systemDirArg = systemFlagIdx >= 0 ? args[systemFlagIdx + 1] : undefined;

if (!dir) {
  console.error('usage: check-detail-design <spec-dir> [--system <dir>]');
  process.exit(2);
}

const specAcIds = uniq(readOrExit(requirementsDocPath(resolve(dir)), 'requirements.md (legacy: spec.md)').match(AC_RE) ?? []);

// The issue set is the spawn manifest (DOC_TAXONOMY §NANO: no markdown slice docs).
const manifestPath = join(dir, 'issues.yaml');
if (!existsSync(manifestPath)) {
  console.error(`no issues.yaml under ${dir} — to-detail-design emits the issue set there`);
  process.exit(2);
}
const manifest = parseYaml(readOrExit(manifestPath, 'issues.yaml')) as
  | { issues?: Array<Record<string, unknown>> }
  | null;
const rawIssues = manifest?.issues;
if (!Array.isArray(rawIssues)) {
  console.error('issues.yaml has no `issues:` list');
  process.exit(2);
}
const issues: IssueCore[] = [];
rawIssues.forEach((it, i) => {
  if (!it || typeof it.key !== 'string') {
    console.error(`issues[${i}] missing string \`key\``);
    process.exit(2);
  }
  issues.push({
    key: it.key,
    coversAcIds: (it.coversAcIds as string[]) ?? [],
    dependsOnIssues: (it.dependsOnIssues as string[]) ?? [],
    dependsOnSystem: (it.dependsOnSystem as string[]) ?? [],
  });
});

// Default system layer: the dir's sibling `_system` (legacy docs/specs layout), else the
// grandparent's (docs/_system beside docs/requirements — the ideal-tree layout).
const siblingSystem = resolve(dir, '..', '_system');
const systemDir = systemDirArg ? resolve(systemDirArg) : existsSync(siblingSystem) ? siblingSystem : resolve(dir, '..', '..', '_system');
let systemElementIds: string[] = [];
const systemChecked = existsSync(systemDir);
if (systemChecked) {
  // Recurse: the system layer is organised per bounded context (_system/<ctx>/*.md).
  for (const rel of readdirSync(systemDir, { recursive: true }) as string[]) {
    if (!rel.endsWith('.md')) continue;
    systemElementIds.push(...(readFileSync(join(systemDir, rel), 'utf8').match(SYS_RE) ?? []));
  }
  systemElementIds = uniq(systemElementIds);
}

const result = lintDesign({ specAcIds, issues, systemElementIds });

if (!systemChecked && issues.some((s) => s.dependsOnSystem.length)) {
  console.warn(`note: system layer not found at ${systemDir}; dependsOnSystem existence NOT verified`);
}

if (result.ok) {
  console.log(
    `check-detail-design: OK (${issues.length} issues, ${specAcIds.length} AC, ${systemElementIds.length} system elements)`,
  );
  process.exit(0);
}
console.error('check-detail-design: FAILED');
for (const e of result.errors) console.error(`  - ${e}`);
process.exit(1);
