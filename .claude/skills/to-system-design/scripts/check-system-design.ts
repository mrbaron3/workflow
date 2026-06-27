#!/usr/bin/env tsx
/**
 * Integrity check for a system-design contribution (domain-map + architecture + data-model):
 * a thin wrapper that parses the spec's design-delta.md (reads/extends element ids) and verifies
 * every referenced id is present in the global system layer, delegating to the vendored
 * deterministic tier in ./lib/design-lint.ts. The skill's prose never re-implements the rules.
 *
 * Run from anywhere:
 *   npx tsx <skill>/scripts/check-system-design.ts <spec-dir> [--system <dir>]
 *
 * <spec-dir> holds design-delta.md. The global system layer is found at
 * <spec-dir>/../_system by default (override with --system <dir>).
 * Exit: 0 = passed, 1 = lint failed, 2 = usage / read error.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { checkReferencesPresent } from './lib/design-lint.js';

interface DeltaRef {
  elementId?: string;
}
interface DesignDeltaCore {
  reads?: DeltaRef[];
  extends?: DeltaRef[];
}

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
  console.error('usage: check-system-design <spec-dir> [--system <dir>]');
  process.exit(2);
}

const block = firstYamlBlock(readOrExit(join(dir, 'design-delta.md'), 'design-delta.md'));
if (!block) {
  console.error('design-delta.md has no ```yaml core block');
  process.exit(2);
}
const delta = parseYaml(block) as DesignDeltaCore;
const referenced = uniq(
  [...(delta.reads ?? []), ...(delta.extends ?? [])].map((r) => r.elementId).filter((x): x is string => !!x),
);

const systemDir = systemDirArg ? resolve(systemDirArg) : resolve(dir, '..', '_system');
if (!existsSync(systemDir)) {
  console.error(`system layer not found at ${systemDir}`);
  process.exit(2);
}
const present: string[] = [];
for (const f of readdirSync(systemDir).filter((x) => x.endsWith('.md'))) {
  present.push(...(readFileSync(join(systemDir, f), 'utf8').match(SYS_RE) ?? []));
}

const r = checkReferencesPresent(referenced, uniq(present));

if (r.ok) {
  console.log(`check-system-design: OK (${referenced.length} referenced ids, all present)`);
  process.exit(0);
}
console.error('check-system-design: FAILED');
console.error(`  - delta references element not present in system layer: ${r.dangling.join(', ')}`);
process.exit(1);
