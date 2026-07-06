/**
 * Scoped-context assembler (ARCH-execution-007, realising LANG-execution-006 / P5): resolve the
 * MINIMAL design context a session needs from the ids its issue declares in `dependsOnSystem` —
 * id references resolved fresh from the system views, NEVER a copied snapshot or a whole-design
 * dump (DOM-execution-001 pollution prevention).
 *
 * Pure and deterministic: it reads the `_system` markdown, maps each `<KIND>-<ctx>-<NNN>` id to
 * its one defining bullet, and returns the requested ids' text. A referenced id with no definition
 * is surfaced (missing), not silently dropped — a dangling design reference is a real signal.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Issue } from '../../domain/schema.js';

/** A system element id: LANG-execution-006, ARCH-evaluation-002, DATA-execution-005, … */
const SYS_ID_RE = /\b((?:LANG|DOM|ARCH|DATA)-[a-z]+-\d{3})\b/;

export interface SystemContextEntry {
  id: string;
  /** The element's defining line from the system view, or null when the id resolves to nothing. */
  text: string | null;
}

export interface ScopedContext {
  resolved: SystemContextEntry[]; // found, in the order requested
  missing: string[]; // ids referenced by the issue but absent from the system views
}

/** Build id -> defining line by scanning every markdown file under `systemDir` for a leading id. */
function indexSystemElements(systemDir: string): Map<string, string> {
  const index = new Map<string, string>();
  if (!fs.existsSync(systemDir)) return index;
  const files = (fs.readdirSync(systemDir, { recursive: true }) as string[]).filter((f) => f.endsWith('.md'));
  for (const rel of files) {
    const lines = fs.readFileSync(path.join(systemDir, rel), 'utf8').split('\n');
    for (const line of lines) {
      // an element is DEFINED either on a bullet ("- **ARCH-x-001 …**") or as a table row
      // ("| LANG-x-001 | term | … |") — the two conventions the system views use (LANG in a table).
      const bullet = line.match(/^\s*[-*]\s+\*{0,2}((?:LANG|DOM|ARCH|DATA)-[a-z]+-\d{3})\b/);
      const row = line.match(/^\s*\|\s*\*{0,2}((?:LANG|DOM|ARCH|DATA)-[a-z]+-\d{3})\b/);
      const m = bullet ?? row;
      if (m && !index.has(m[1]!)) index.set(m[1]!, line.trim().replace(/^[-*]\s+/, ''));
    }
  }
  return index;
}

/**
 * Resolve a set of system-element ids to their defining lines from `systemDir`. Order-preserving;
 * duplicates collapsed. Ids that don't match the system-id shape are ignored (not "missing").
 */
export function resolveSystemContext(ids: string[], systemDir: string): ScopedContext {
  const index = indexSystemElements(systemDir);
  const resolved: SystemContextEntry[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = raw.match(SYS_ID_RE)?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const text = index.get(id) ?? null;
    if (text === null) missing.push(id);
    resolved.push({ id, text });
  }
  return { resolved, missing };
}

/** The scoped design context for one issue: exactly its `dependsOnSystem`, resolved from `systemDir`. */
export function contextFor(issue: Issue, systemDir: string): ScopedContext {
  return resolveSystemContext(issue.dependsOnSystem, systemDir);
}

/** Render the resolved context as the prompt section a session reads (empty string when nothing resolves). */
export function renderScopedContext(ctx: ScopedContext): string {
  const found = ctx.resolved.filter((e) => e.text !== null);
  if (found.length === 0) return '';
  const lines = [
    `## Referenced design (system elements this issue depends on)`,
    `Honour these; they are the design contract this work sits inside. Do not re-derive or contradict them.`,
    ...found.map((e) => `- ${e.text}`),
  ];
  if (ctx.missing.length > 0) lines.push(`\n> Note: these referenced ids were not found in the system views: ${ctx.missing.join(', ')}`);
  return lines.join('\n');
}
