#!/usr/bin/env tsx
/**
 * Signing-gate integrity check for an epic's authored spec (ADR-0005 D37): a thin
 * wrapper that parses spec.md + acceptance.yaml and delegates to the shared
 * deterministic lint in src/authoring/lint.ts. The skill calls this; the skill's
 * prose never re-implements the rules.
 *
 * Run from the repo root:
 *   npx tsx .claude/skills/authoring-assist/scripts/check-spec.ts <epic-dir>
 * Exit: 0 = passed, 1 = lint failed, 2 = usage / read error.
 *
 * The shared library is imported via a CWD-anchored absolute path (not a relative
 * path), so the script does not depend on its own depth under .claude/skills/.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

interface LintInput {
  specAcIds: string[];
  acceptanceAcIds: string[];
  methodsById: Record<string, string>;
}
interface LintResult {
  ok: boolean;
  errors: string[];
}

const dir = process.argv[2];
if (!dir) {
  console.error('usage: check-spec <epic-dir>   (dir containing spec.md and acceptance.yaml)');
  process.exit(2);
}

const lintModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/authoring/lint.ts')).href;
const { lintAuthoring } = (await import(lintModuleUrl)) as { lintAuthoring: (i: LintInput) => LintResult };

let specText: string;
let acceptanceText: string;
try {
  specText = readFileSync(join(dir, 'spec.md'), 'utf8');
  acceptanceText = readFileSync(join(dir, 'acceptance.yaml'), 'utf8');
} catch (err) {
  console.error(`✗ cannot read spec.md / acceptance.yaml in ${dir}: ${(err as Error).message}`);
  process.exit(2);
}

// AC-IDs from spec.md scenario anchors: `- **[AC-FOO-001] ...**` (keep order + duplicates for the lint).
const specAcIds = [...specText.matchAll(/\[(AC-[A-Z0-9]+-\d+)\]/g)].map((m) => m[1]!);

const acc = (parseYaml(acceptanceText) ?? {}) as { verifications?: Record<string, { method?: string }> };
const verifications = acc.verifications ?? {};
const acceptanceAcIds = Object.keys(verifications);
const methodsById: Record<string, string> = {};
for (const [id, v] of Object.entries(verifications)) methodsById[id] = v?.method ?? '(missing)';

const res = lintAuthoring({ specAcIds, acceptanceAcIds, methodsById });
if (res.ok) {
  console.log(`✓ authoring lint passed: ${acceptanceAcIds.length} acceptance criteria, coverage OK`);
  process.exit(0);
}
console.error('✗ authoring lint failed:');
for (const e of res.errors) console.error(`  - ${e}`);
process.exit(1);
