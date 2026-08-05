import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as YAML from 'yaml';

import {
  AGENTOPS_PACKAGE_ROOT,
  REPOSITORY_ROOT,
  repositoryPath,
} from '../src/runtime/roots.js';

const SOURCE_ROOT = path.join(AGENTOPS_PACKAGE_ROOT, 'src');
const APPLICATION_CODE_ROOTS = [
  SOURCE_ROOT,
  path.join(AGENTOPS_PACKAGE_ROOT, 'scripts'),
];
const CONTROL_PLANE_ROOT = path.join(REPOSITORY_ROOT, 'apps', 'control-plane');

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(target);
      return entry.isFile() && entry.name.endsWith('.ts') ? [target] : [];
    });
}

function moduleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
}

describe('AgentOps application boundary', () => {
  it('resolves shared contracts and migrations from the repository root', () => {
    expect(fs.statSync(repositoryPath('contracts', 'control-store', 'v1')).isDirectory())
      .toBe(true);
    expect(fs.statSync(repositoryPath('db', 'control-store', 'migrations')).isDirectory())
      .toBe(true);
  });

  it('keeps every relative source import inside apps/agentops', () => {
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const specifier of moduleSpecifiers(source)) {
        if (!specifier.startsWith('.')) continue;
        const imported = path.resolve(path.dirname(file), specifier);
        expect(
          isWithin(AGENTOPS_PACKAGE_ROOT, imported),
          `${path.relative(AGENTOPS_PACKAGE_ROOT, file)} imports ${specifier}`,
        ).toBe(true);
        expect(
          isWithin(CONTROL_PLANE_ROOT, imported),
          `${path.relative(AGENTOPS_PACKAGE_ROOT, file)} imports the control-plane app`,
        ).toBe(false);
      }
    }
  });

  it('does not construct a filesystem path into apps/control-plane from app source', () => {
    for (const file of APPLICATION_CODE_ROOTS.flatMap(sourceFiles)) {
      const source = fs.readFileSync(file, 'utf8');
      const normalizedPathExpressions = source
        .replaceAll('\\', '/')
        .replace(/['"`\s,]+/g, '/')
        .replace(/\/{2,}/g, '/');
      expect(
        normalizedPathExpressions.includes('apps/control-plane'),
        `${path.relative(AGENTOPS_PACKAGE_ROOT, file)} reads the control-plane app`,
      ).toBe(false);
    }
  });

  it('keeps repository-root self-hosting scopes inside the AgentOps app', () => {
    const selfRun = fs.readFileSync(
      path.join(AGENTOPS_PACKAGE_ROOT, 'scripts', 'real-run-self.ts'),
      'utf8',
    );
    expect(selfRun).toContain('-p apps/agentops/tsconfig.json');
    expect(selfRun).toContain('--config apps/agentops/vitest.config.ts');
    expect(selfRun).toContain(
      "protectedPaths: ['apps/agentops/test/acceptance-harness/']",
    );

    const seedRoot = path.join(AGENTOPS_PACKAGE_ROOT, 'scripts', 'seeds');
    for (const name of fs.readdirSync(seedRoot).filter((entry) =>
      entry.endsWith('.contract.yaml'))) {
      const contract = YAML.parse(
        fs.readFileSync(path.join(seedRoot, name), 'utf8'),
      ) as { scope: { include: string[]; exclude: string[] } };
      for (const scopedPath of [
        ...contract.scope.include,
        ...contract.scope.exclude,
      ]) {
        expect(scopedPath, `${name} has a repository-root scope`).toMatch(
          /^apps\/agentops\//,
        );
      }
    }
  });
});
