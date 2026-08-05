import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));

function findAncestor(start: string, predicate: (directory: string) => boolean): string {
  let current = path.resolve(start);
  while (true) {
    if (predicate(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`unable to resolve an application root from ${start}`);
    }
    current = parent;
  }
}

function isAgentopsPackage(directory: string): boolean {
  const manifest = path.join(directory, 'package.json');
  if (!fs.existsSync(manifest)) return false;
  try {
    const value = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: unknown };
    return value.name === 'agentops-harness';
  } catch {
    return false;
  }
}

function isRepositoryRoot(directory: string): boolean {
  return fs.existsSync(path.join(directory, 'contracts', 'control-store', 'v1'))
    && fs.existsSync(path.join(directory, 'db', 'control-store', 'migrations'));
}

/** The TypeScript application's package root, valid from both src/ and dist/. */
export const AGENTOPS_PACKAGE_ROOT = findAncestor(sourceDirectory, isAgentopsPackage);

/**
 * The monorepo integration root that owns language-neutral contracts and DB migrations.
 * Production images may set AGENTOPS_REPOSITORY_ROOT explicitly; local builds discover it
 * without relying on process.cwd(), which remains the target workspace for the harness CLI.
 */
export const REPOSITORY_ROOT = (() => {
  const configured = process.env.AGENTOPS_REPOSITORY_ROOT?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error('AGENTOPS_REPOSITORY_ROOT must be an absolute path');
    }
    if (!isRepositoryRoot(configured)) {
      throw new Error(`AGENTOPS_REPOSITORY_ROOT has no shared contracts/migrations: ${configured}`);
    }
    return path.resolve(configured);
  }
  return findAncestor(AGENTOPS_PACKAGE_ROOT, isRepositoryRoot);
})();

export function agentopsPackagePath(...parts: string[]): string {
  return path.join(AGENTOPS_PACKAGE_ROOT, ...parts);
}

export function repositoryPath(...parts: string[]): string {
  return path.join(REPOSITORY_ROOT, ...parts);
}
