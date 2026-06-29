#!/usr/bin/env tsx
/**
 * Integrity check for a system-design contribution (ubiquitous-language + domain-model +
 * architecture + data-model). A thin wrapper that parses a run's design-delta.md
 * (reads/extends element ids) and checks it against the global system layer, delegating to
 * the vendored deterministic tier in ./lib/design-lint.ts. The skill's prose never
 * re-implements the rules.
 *
 * The check is **source-agnostic** — it does not read spec.md/acceptance.yaml and does not
 * care whether the delta came from a signed spec, a top-down requirement, or reverse
 * engineering. It only knows two shapes:
 *
 *   forward  (default)  — the delta has been written into the system layer. Every referenced
 *                         id (reads ∪ extends) must already be present in _system.
 *   proposal (--proposal) — the delta is a STAGED draft (reverse mode): its `extends` are NOT
 *                         yet in _system. We assert it is additive (no extends id collides with
 *                         an existing element) and that its `reads` resolve against
 *                         _system ∪ the proposal's own new ids. No spec linkage required.
 *
 * Run from anywhere:
 *   npx tsx <skill>/scripts/check-system-design.ts <run-dir> [--system <dir>] [--proposal]
 *
 * <run-dir> holds design-delta.md (a spec dir in forward mode, a proposal dir in proposal
 * mode). The system layer is found at <run-dir>/../_system by default (override with
 * --system <dir>); element ids are read recursively from every *.md beneath it, organised
 * per bounded context (_system/<ctx>/*.md). A missing system layer is treated as empty
 * (greenfield) with a notice, not an error.
 * Exit: 0 = passed, 1 = lint failed, 2 = usage / read error.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { checkReferencesPresent, checkAdditive } from './lib/design-lint.js';

/**
 * Resolve the system layer when --system isn't given. The canonical tree puts `_system/` as a
 * sibling of `specs/` (e.g. docs/_system + docs/specs/<feature>/), so a spec dir's immediate
 * `../_system` is the wrong place. Walk up from the run dir and take the nearest ancestor that
 * has a `_system/` child; fall back to the legacy `<run-dir>/../_system` (may be greenfield-absent).
 */
function findSystemDir(runDir: string): string {
  let cur = resolve(runDir);
  for (let i = 0; i < 64; i++) {
    const parent = dirname(cur);
    const candidate = join(parent, '_system');
    if (existsSync(candidate)) return candidate;
    if (parent === cur) break; // reached filesystem root
    cur = parent;
  }
  return resolve(runDir, '..', '_system');
}

interface DeltaRef {
  elementId?: string;
}
interface DesignDeltaCore {
  reads?: DeltaRef[];
  extends?: DeltaRef[];
}

// Context-segmented system element ids: <KIND>-<ctx>-NNN (DOC_TAXONOMY §ID 体系).
const SYS_RE = /\b(?:LANG|DOM|ARCH|DATA|CONTRACT)-[a-z0-9]+(?:-[a-z0-9]+)*-\d+\b/g;
const uniq = (xs: string[]): string[] => [...new Set(xs)];
const ids = (refs: DeltaRef[] | undefined): string[] =>
  (refs ?? []).map((r) => r.elementId).filter((x): x is string => !!x);

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
const proposal = args.includes('--proposal');
const systemFlagIdx = args.indexOf('--system');
const systemDirArg = systemFlagIdx >= 0 ? args[systemFlagIdx + 1] : undefined;

if (!dir) {
  console.error('usage: check-system-design <run-dir> [--system <dir>] [--proposal]');
  process.exit(2);
}

const block = firstYamlBlock(readOrExit(join(dir, 'design-delta.md'), 'design-delta.md'));
if (!block) {
  console.error('design-delta.md has no ```yaml core block');
  process.exit(2);
}
const delta = parseYaml(block) as DesignDeltaCore;
const reads = uniq(ids(delta.reads));
const extend = uniq(ids(delta.extends));

// Gather element ids already present in the system layer. Missing layer = greenfield (empty).
const systemDir = systemDirArg ? resolve(systemDirArg) : findSystemDir(dir);
const present: string[] = [];
if (existsSync(systemDir)) {
  // Recurse: the system layer is organised per bounded context (_system/<ctx>/*.md).
  for (const rel of readdirSync(systemDir, { recursive: true }) as string[]) {
    if (!rel.endsWith('.md')) continue;
    present.push(...(readFileSync(join(systemDir, rel), 'utf8').match(SYS_RE) ?? []));
  }
} else {
  console.error(`note: system layer not found at ${systemDir} — treating as greenfield (empty)`);
}
const presentUniq = uniq(present);

const errors: string[] = [];
if (proposal) {
  // Staged draft: extends are new (must be additive); reads resolve against existing ∪ new.
  const additive = checkAdditive(presentUniq, extend);
  if (!additive.ok) {
    errors.push(`proposal is not additive — ids already exist in the system layer: ${additive.rewritten.join(', ')}`);
  }
  const refs = checkReferencesPresent(reads, uniq([...presentUniq, ...extend]));
  if (!refs.ok) {
    errors.push(`delta reads reference element not present in system layer or proposal: ${refs.dangling.join(', ')}`);
  }
} else {
  // Forward (spec-driven / top-down): the delta is written into _system; everything resolves there.
  const refs = checkReferencesPresent(uniq([...reads, ...extend]), presentUniq);
  if (!refs.ok) {
    errors.push(`delta references element not present in system layer: ${refs.dangling.join(', ')}`);
  }
}

const mode = proposal ? 'proposal' : 'forward';
if (errors.length === 0) {
  console.log(
    `check-system-design: OK [${mode}] (${reads.length} reads, ${extend.length} extends, all consistent)`,
  );
  process.exit(0);
}
console.error(`check-system-design: FAILED [${mode}]`);
for (const e of errors) console.error(`  - ${e}`);
process.exit(1);
