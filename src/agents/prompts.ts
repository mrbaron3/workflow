/**
 * Resolves the on-disk role prompts (agents/*.md) and templates (templates/*).
 * These are the actual prompts you would feed a real coding agent; the harness
 * loads them so prompt text lives in version-controlled files, not in code.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentRole } from '../domain/schema.js';

// src/agents/prompts.ts -> package root is two levels up (works for tsx and dist).
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function pkgPath(...parts: string[]): string {
  return path.join(PKG_ROOT, ...parts);
}

export function loadRolePrompt(role: AgentRole): string {
  const f = pkgPath('agents', `${role}.md`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}

export function loadTemplate(name: string): string {
  const f = pkgPath('templates', name);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}
