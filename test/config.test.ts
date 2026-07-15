/**
 * loadConfig merge semantics. Two shapes coexist on purpose: keys with a DEFAULT_CONFIG entry
 * (scoreWeights, panel) are deep-merged so a partial override keeps the untouched defaults; keys
 * with no default (models, gate, target) pass straight through from the file. This test pins the
 * `models` passthrough the per-role model overrides rely on, plus the deep-merge for scoreWeights.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadConfig,
  DEFAULT_CONFIG,
  saveConfig,
  resolveTargetRoot,
  configuredGraderCommand,
  type HarnessConfig,
} from '../src/config.js';

const dirs: string[] = [];
function tmpRoot(cfg: Partial<HarnessConfig>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-config-'));
  dirs.push(root);
  saveConfig(root, cfg as HarnessConfig);
  return root;
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('loadConfig', () => {
  it('defaults models to undefined when the file omits it (every role inherits the user default)', () => {
    const cfg = loadConfig(tmpRoot({ generator: 'claude' }));
    expect(cfg.models).toBeUndefined();
  });

  it('passes models straight through from the file', () => {
    const cfg = loadConfig(tmpRoot({ models: { generator: 'haiku' } }));
    expect(cfg.models).toEqual({ generator: 'haiku' });
  });

  it('deep-merges scoreWeights so a partial override keeps the other defaults', () => {
    const cfg = loadConfig(tmpRoot({ scoreWeights: { functionality: 0.9 } as HarnessConfig['scoreWeights'] }));
    expect(cfg.scoreWeights.functionality).toBe(0.9); // overridden
    expect(cfg.scoreWeights.codeQuality).toBe(DEFAULT_CONFIG.scoreWeights.codeQuality); // untouched
  });

  it('returns a copy of the defaults when no config file exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-config-'));
    dirs.push(root);
    expect(loadConfig(root)).toEqual(DEFAULT_CONFIG);
  });
});

describe('resolveTargetRoot (D4)', () => {
  it('defaults to harnessRoot when config.target is absent', () => {
    expect(resolveTargetRoot(DEFAULT_CONFIG, '/harness')).toBe('/harness');
  });

  it('defaults to harnessRoot when target.repo is the explicit self-hosting spelling "."', () => {
    expect(resolveTargetRoot({ ...DEFAULT_CONFIG, target: { repo: '.' } }, '/harness')).toBe('/harness');
  });

  it('resolves a relative target.repo against harnessRoot', () => {
    expect(resolveTargetRoot({ ...DEFAULT_CONFIG, target: { repo: '../channel-compass' } }, '/work/harness')).toBe(
      '/work/channel-compass',
    );
  });

  it('passes an absolute target.repo through unchanged', () => {
    expect(resolveTargetRoot({ ...DEFAULT_CONFIG, target: { repo: '/abs/target' } }, '/harness')).toBe('/abs/target');
  });
});

describe('configuredGraderCommand (FEAT-019)', () => {
  it('prefers the canonical method registry and preserves legacy unit/typecheck aliases', () => {
    const target = {
      repo: '.',
      graders: {
        typecheck: 'legacy-tsc',
        unit_tests: 'legacy-vitest',
        commands: { typecheck: 'canonical-tsc', playwright: 'browser-check' },
      },
    };
    expect(configuredGraderCommand(target, 'typecheck')).toBe('canonical-tsc');
    expect(configuredGraderCommand(target, 'unit_test')).toBe('legacy-vitest');
    expect(configuredGraderCommand(target, 'playwright')).toBe('browser-check');
    expect(configuredGraderCommand(target, 'api_test')).toBeUndefined();
    expect(configuredGraderCommand({ repo: '.', graders: { commands: { manual: 'never-run' } } }, 'manual')).toBeUndefined();
  });
});
