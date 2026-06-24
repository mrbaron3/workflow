#!/usr/bin/env tsx
/**
 * Pre-spawn integrity check for an epic's slice decomposition: a thin wrapper that
 * parses the epic's slice files (+ spec.md AC anchors + the global _system element
 * ids) and delegates to the vendored deterministic tier in ./lib/design-lint.ts. The
 * skill's prose never re-implements these rules.
 *
 * Run from anywhere:
 *   npx tsx <skill>/scripts/check-detail-design.ts <epic-dir> [--system <dir>]
 *
 * <epic-dir> holds spec.md and slices/SLICE-*.md. The global system layer is found at
 * <epic-dir>/../_system by default (override with --system <dir>).
 * Exit: 0 = passed, 1 = lint failed, 2 = usage / read error.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { lintDesign, type SliceCore } from './lib/design-lint.js';

const AC_RE = /\bAC-[A-Z0-9]+-\d+\b/g;
const SYS_RE = /\b(?:DOM|DATA|ARCH)-\d+\b/g;
const uniq = (xs: string[]): string[] => [...new Set(xs)];

function firstYamlBlock(text: string): string | undefined {
  const m = text.match(/```ya?ml\n([\s\S]*?)```/);
  return m ? m[1] : undefined;
}
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
  console.error('usage: check-detail-design <epic-dir> [--system <dir>]');
  process.exit(2);
}

const specAcIds = uniq(readOrExit(join(dir, 'spec.md'), 'spec.md').match(AC_RE) ?? []);

const slicesDir = join(dir, 'slices');
if (!existsSync(slicesDir)) {
  console.error(`no slices/ dir under ${dir}`);
  process.exit(2);
}
const slices: SliceCore[] = [];
for (const f of readdirSync(slicesDir).filter((x) => x.endsWith('.md'))) {
  const block = firstYamlBlock(readFileSync(join(slicesDir, f), 'utf8'));
  if (!block) {
    console.error(`slice ${f} has no \`\`\`yaml core block`);
    process.exit(2);
  }
  const core = parseYaml(block) as Partial<SliceCore>;
  if (!core.sliceId) {
    console.error(`slice ${f} core missing sliceId`);
    process.exit(2);
  }
  slices.push({
    sliceId: core.sliceId,
    coversAcIds: core.coversAcIds ?? [],
    dependsOnSlices: core.dependsOnSlices ?? [],
    dependsOnSystem: core.dependsOnSystem ?? [],
  });
}

const systemDir = systemDirArg ? resolve(systemDirArg) : resolve(dir, '..', '_system');
let systemElementIds: string[] = [];
const systemChecked = existsSync(systemDir);
if (systemChecked) {
  for (const f of readdirSync(systemDir).filter((x) => x.endsWith('.md'))) {
    systemElementIds.push(...(readFileSync(join(systemDir, f), 'utf8').match(SYS_RE) ?? []));
  }
  systemElementIds = uniq(systemElementIds);
}

const result = lintDesign({ specAcIds, slices, systemElementIds });

if (!systemChecked && slices.some((s) => s.dependsOnSystem.length)) {
  console.warn(`note: system layer not found at ${systemDir}; dependsOnSystem existence NOT verified`);
}

if (result.ok) {
  console.log(
    `check-detail-design: OK (${slices.length} slices, ${specAcIds.length} AC, ${systemElementIds.length} system elements)`,
  );
  process.exit(0);
}
console.error('check-detail-design: FAILED');
for (const e of result.errors) console.error(`  - ${e}`);
process.exit(1);
