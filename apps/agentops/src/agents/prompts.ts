/**
 * Resolves the on-disk role prompts (agents/*.md). These are the actual prompts
 * you would feed a real coding agent; the harness loads them so prompt text lives
 * in version-controlled files, not in code.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AgentRole } from '../domain/schema.js';
import { AGENTOPS_PACKAGE_ROOT } from '../runtime/roots.js';

export function pkgPath(...parts: string[]): string {
  return path.join(AGENTOPS_PACKAGE_ROOT, ...parts);
}

export function loadRolePrompt(role: AgentRole): string {
  const f = pkgPath('agents', `${role}.md`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}
