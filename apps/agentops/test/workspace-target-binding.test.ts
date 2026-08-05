import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type HarnessConfig } from '../src/config.js';
import { Store } from '../src/store/store.js';
import {
  BindingMismatchError,
  LegacyUnboundStoreError,
  bindLegacyStore,
  commandChangesStore,
  prepareStoreMutation,
  resolveTargetIdentity,
} from '../src/workspace/target-binding.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { harnessRoot: string; targetA: string; targetB: string; store: Store } {
  const harnessRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentops-target-binding-'));
  roots.push(harnessRoot);
  const targetA = path.join(harnessRoot, 'target-a');
  const targetB = path.join(harnessRoot, 'target-b');
  fs.mkdirSync(targetA);
  fs.mkdirSync(targetB);
  return { harnessRoot, targetA, targetB, store: new Store(harnessRoot) };
}

function cfg(repo: string): HarnessConfig {
  return { ...DEFAULT_CONFIG, target: { repo } };
}

describe('workspace target binding', () => {
  it('AC-STBIND-001 binds an empty store once and preserves the binding across save/reload', () => {
    const { harnessRoot, targetA, store } = fixture();
    const now = () => '2026-07-14T00:00:00.000Z';

    expect(prepareStoreMutation(store, cfg(targetA), harnessRoot, { now })).toBe('bound-empty');
    const first = structuredClone(store.db.targetBinding);
    expect(first).toEqual({ targetIdentity: fs.realpathSync(targetA), boundAt: now() });
    store.save();

    const reloaded = new Store(harnessRoot);
    expect(prepareStoreMutation(reloaded, cfg(targetA), harnessRoot, { now: () => 'later' })).toBe('matched');
    expect(reloaded.db.targetBinding).toEqual(first);
  });

  it('AC-STBIND-002 canonicalises equivalent repository path spellings', () => {
    const { harnessRoot, targetA } = fixture();
    const alias = path.join(targetA, '..', path.basename(targetA));
    expect(resolveTargetIdentity(cfg(targetA), harnessRoot)).toBe(resolveTargetIdentity(cfg(alias), harnessRoot));
  });

  it('AC-STBIND-003 rejects a mismatched target before any store mutation', () => {
    const { harnessRoot, targetA, targetB, store } = fixture();
    prepareStoreMutation(store, cfg(targetA), harnessRoot, { now: () => 'bound-at' });
    store.db.roadmap = { vision: 'target A', principles: [], epicIds: [] };
    const before = structuredClone(store.db);

    expect(() => prepareStoreMutation(store, cfg(targetB), harnessRoot)).toThrow(BindingMismatchError);
    expect(store.db).toEqual(before);
    try {
      prepareStoreMutation(store, cfg(targetB), harnessRoot);
    } catch (error) {
      expect(String(error)).toContain(fs.realpathSync(targetA));
      expect(String(error)).toContain(fs.realpathSync(targetB));
    }
  });

  it('AC-STBIND-004 never rebinds an already-bound store through either seam', () => {
    const { harnessRoot, targetA, targetB, store } = fixture();
    prepareStoreMutation(store, cfg(targetA), harnessRoot, { now: () => 'first' });
    const first = structuredClone(store.db.targetBinding);

    expect(() => bindLegacyStore(store, cfg(targetB), harnessRoot)).toThrow(BindingMismatchError);
    expect(store.db.targetBinding).toEqual(first);
  });

  it('AC-STBIND-005 fails closed for a non-empty legacy store until explicit binding', () => {
    const { harnessRoot, targetA, store } = fixture();
    store.db.roadmap = { vision: 'legacy truth', principles: ['keep'], epicIds: [] };
    const legacy = structuredClone(store.db);

    expect(() => prepareStoreMutation(store, cfg(targetA), harnessRoot)).toThrow(LegacyUnboundStoreError);
    expect(store.db).toEqual(legacy);

    expect(bindLegacyStore(store, cfg(targetA), harnessRoot, { now: () => 'migration' })).toBe('bound');
    expect(store.db.roadmap).toEqual(legacy.roadmap);
    expect(prepareStoreMutation(store, cfg(targetA), harnessRoot)).toBe('matched');
  });

  it('AC-STBIND-006 keeps read-only commands available and separate stores independent', () => {
    const a = fixture();
    const b = fixture();
    prepareStoreMutation(a.store, cfg(a.targetA), a.harnessRoot, { now: () => 'a' });
    prepareStoreMutation(b.store, cfg(b.targetB), b.harnessRoot, { now: () => 'b' });
    a.store.db.roadmap = { vision: 'A', principles: [], epicIds: [] };
    b.store.db.roadmap = { vision: 'B', principles: [], epicIds: [] };

    expect(commandChangesStore('status', {})).toBe(false);
    expect(commandChangesStore('plan-tree', {})).toBe(false);
    expect(commandChangesStore('plan-roadmap', {})).toBe(true);
    expect(commandChangesStore('poll-intake', {})).toBe(true);
    expect(commandChangesStore('github-turn', {})).toBe(true);
    expect(commandChangesStore('watch-github', {})).toBe(true);
    expect(commandChangesStore('analyze', {})).toBe(false);
    expect(commandChangesStore('analyze', { create: true })).toBe(true);
    expect(a.store.db.roadmap?.vision).toBe('A');
    expect(b.store.db.roadmap?.vision).toBe('B');
    expect(a.store.db.targetBinding).not.toEqual(b.store.db.targetBinding);
  });
});
