import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import {
  DEFAULT_CONTAINER_PATHS,
  HostPathDependencyError,
  MAC_HOME_ROOT,
  assertNoHostPathDependencies,
  isHostAbsolutePath,
  resolveContainerPaths,
  scanForHostPathDependencies,
} from '../src/runtime/paths.js';

const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-runtime-paths-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

/** A macOS home path built from the exported marker, so this test file carries no bare literal. */
const HOST_PATH = `${MAC_HOME_ROOT}alice/Company/Development/workflow`;

describe('container-neutral path resolution', () => {
  it('resolves to container-absolute defaults with an empty env', () => {
    expect(resolveContainerPaths({})).toEqual(DEFAULT_CONTAINER_PATHS);
  });

  it('honors env overrides for each in-container root', () => {
    const resolved = resolveContainerPaths({
      AGENTOPS_APP_ROOT: '/srv/app',
      AGENTOPS_WORKSPACE_ROOT: '/mnt/work',
      AGENTOPS_STORE_ROOT: '/data/agentops',
      AGENTOPS_SYSTEM_DIR: '/srv/app/docs/_system',
    });
    expect(resolved).toEqual({
      appRoot: '/srv/app',
      workspaceRoot: '/mnt/work',
      storeRoot: '/data/agentops',
      systemDir: '/srv/app/docs/_system',
    });
  });

  it('AC-CISO-011 fails closed when an override points into the macOS home tree', () => {
    expect(() => resolveContainerPaths({ AGENTOPS_WORKSPACE_ROOT: `${HOST_PATH}/ws` }))
      .toThrow(HostPathDependencyError);
    expect(isHostAbsolutePath(`${HOST_PATH}/ws`)).toBe(true);
    expect(isHostAbsolutePath('/workspace')).toBe(false);
  });

  it('fails closed on a relative override (non-deterministic, cwd-dependent) — container paths must be absolute', () => {
    expect(() => resolveContainerPaths({ AGENTOPS_WORKSPACE_ROOT: 'relative/workspace' }))
      .toThrow(HostPathDependencyError);
    expect(() => resolveContainerPaths({ AGENTOPS_STORE_ROOT: 'data' }))
      .toThrow(HostPathDependencyError);
  });
});

describe('host-path dependency scanner', () => {
  it('finds a hardcoded macOS home path in the build surface', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'nested', 'bad.ts'),
      `export const workspace = '${HOST_PATH}';\n`,
    );
    const findings = scanForHostPathDependencies(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: path.join('src', 'nested', 'bad.ts'), line: 1 });
    expect(() => assertNoHostPathDependencies(root)).toThrow(HostPathDependencyError);
  });

  it('returns no findings for a clean build surface', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'ok.ts'), 'export const workspace = process.cwd();\n');
    expect(scanForHostPathDependencies(root)).toEqual([]);
    expect(() => assertNoHostPathDependencies(root)).not.toThrow();
  });

  it('AC-CISO-011 the real repository build/runtime surface carries no macOS absolute path', () => {
    // Regression guard for issue #11「repository 内の Mac 絶対 path 依存検査」: src + build config must stay clean.
    expect(scanForHostPathDependencies(process.cwd())).toEqual([]);
  });
});
