import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from '../src/store/store.js';
import { spawnIssues } from '../src/planning/planning-tree.js';
import { draftContracts } from '../src/pipeline/contract-draft.js';

function tmpStore(name: string): Store {
  const dir = path.join(os.tmpdir(), 'agentops-test', `contract-draft-${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return new Store(dir);
}

const FIXED = () => '2026-01-01T00:00:00.000Z';

function specMd(acIds: string[]): string {
  const scenarios = acIds
    .map((id) => `- **[${id}] シナリオ ${id}**\n  - Given 前提\n  - When 操作\n  - Then ${id} の観測可能な結果`)
    .join('\n\n');
  return `# テスト機能 受け入れ要件\n\n## 受け入れ基準\n\n${scenarios}\n\n## レッドライン\n\n- 既存を破壊しない\n- 合格基準を緩めない\n`;
}

function acceptanceYaml(acIds: string[]): string {
  const v = acIds
    .map((id, i) => `  ${id}:\n    severity: ${i === 0 ? 'blocker' : 'major'}\n    method: unit_test\n    expected:\n      - "${id} の期待値"`)
    .join('\n');
  return `verifications:\n${v}\n`;
}

/** Author a spec on disk, sign it (fake), and spawn its issues — leaving them planned. */
function signedSpecWithIssues(
  store: Store,
  name: string,
  acIds: string[],
  issuesYaml: string,
  approvedAcIds: string[] = acIds,
): string {
  const specPath = `docs/specs/${name}`;
  const specAbs = path.resolve(store.root, specPath);
  fs.mkdirSync(specAbs, { recursive: true });
  fs.writeFileSync(path.join(specAbs, 'spec.md'), specMd(acIds), 'utf8');
  fs.writeFileSync(path.join(specAbs, 'acceptance.yaml'), acceptanceYaml(acIds), 'utf8');
  fs.writeFileSync(path.join(specAbs, 'issues.yaml'), issuesYaml, 'utf8');
  store.upsertSpecState({
    path: specPath,
    featureId: null,
    approved: {
      signedCommitSha: 'deadbeef',
      specBlobGitSha: 'aaaa',
      acceptanceBlobGitSha: 'bbbb',
      acFingerprints: {},
      systemRefs: [],
      approvedAcIds,
    },
    signedAt: '2026-01-02T00:00:00.000Z',
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  });
  spawnIssues(store, specPath, { now: FIXED });
  return specPath;
}

const TWO_ISSUES = `issues:
  - key: ISSUE-FEAT-001
    title: 最初の issue を実装する
    area: backend
    coversAcIds: [AC-FEAT-001]
  - key: ISSUE-FEAT-002
    title: 2 番目の issue を実装する
    area: frontend
    coversAcIds: [AC-FEAT-002]
`;

describe('draftContracts — signed spec issues become runnable', () => {
  it('AC-CONTRACT-001: every planned issue gets a contract and advances to contract-drafted', () => {
    const store = tmpStore('c001');
    const specPath = signedSpecWithIssues(store, 'feat', ['AC-FEAT-001', 'AC-FEAT-002'], TWO_ISSUES);
    const res = draftContracts(store, specPath);

    expect(res.drafted).toBe(2);
    for (const issue of store.db.issues) {
      expect(issue.contract).not.toBeNull();
      expect(issue.status).toBe('contract-drafted');
    }
  });

  it('AC-CONTRACT-002: contract AC set == coversAcIds, sourced from the signed spec', () => {
    const store = tmpStore('c002');
    const specPath = signedSpecWithIssues(store, 'feat', ['AC-FEAT-001', 'AC-FEAT-002'], TWO_ISSUES);
    draftContracts(store, specPath);

    const i1 = store.db.issues.find((i) => i.coversAcIds.includes('AC-FEAT-001'))!;
    const acIds = i1.contract!.acceptanceCriteria.map((a) => a.id);
    expect(acIds).toEqual(['AC-FEAT-001']); // bidirectional with coversAcIds — no drop, no extra

    const crit = i1.contract!.acceptanceCriteria[0]!;
    expect(crit.severity).toBe('blocker'); // from acceptance.yaml (signed spec), not invented
    expect(crit.verification.method).toBe('unit_test');
    expect(crit.behavior).toContain('AC-FEAT-001 の観測可能な結果'); // behavior comes from spec.md scenario
    expect(crit.verification.expected).toEqual(['AC-FEAT-001 の期待値']);
  });

  it('AC-CONTRACT-003: refuses an unsigned spec and changes nothing', () => {
    const store = tmpStore('c003');
    const specPath = signedSpecWithIssues(store, 'feat', ['AC-FEAT-001', 'AC-FEAT-002'], TWO_ISSUES);
    // Simulate the spec losing its signature after issues were spawned.
    store.getSpecState(specPath)!.approved = null;

    expect(() => draftContracts(store, specPath)).toThrow(/not signed/);
    for (const issue of store.db.issues) {
      expect(issue.status).toBe('planned'); // untouched
      expect(issue.contract).toBeNull();
    }
  });

  it('AC-CONTRACT-004: refuses when an issue covers an AC outside the signed set, changing nothing', () => {
    const store = tmpStore('c004');
    // Spec/issues cover {001,002}, but only 001 is signed (a re-sign drift).
    const specPath = signedSpecWithIssues(store, 'feat', ['AC-FEAT-001', 'AC-FEAT-002'], TWO_ISSUES, ['AC-FEAT-001']);

    expect(() => draftContracts(store, specPath)).toThrow(/AC-FEAT-002/);
    expect(() => draftContracts(store, specPath)).toThrow(/not in the signed AC set/);
    for (const issue of store.db.issues) {
      expect(issue.status).toBe('planned'); // all-or-nothing: even the valid issue is untouched
      expect(issue.contract).toBeNull();
    }
  });

  it('AC-CONTRACT-005: re-drafting is idempotent and never regresses a drafted issue', () => {
    const store = tmpStore('c005');
    const specPath = signedSpecWithIssues(store, 'feat', ['AC-FEAT-001', 'AC-FEAT-002'], TWO_ISSUES);
    draftContracts(store, specPath);
    const snapshot = store.db.issues.map((i) => ({ id: i.id, status: i.status, contract: i.contract }));

    const res2 = draftContracts(store, specPath);
    expect(res2.drafted).toBe(0); // nothing new
    const after = store.db.issues.map((i) => ({ id: i.id, status: i.status, contract: i.contract }));
    expect(after).toEqual(snapshot); // no regression, no duplicate contract
  });

  it('AC-CONTRACT-007: contract scope carries the manifest\'s file globs — never AC ids', () => {
    const store = tmpStore('c007');
    const withScope = `issues:
  - key: ISSUE-FEAT-001
    title: scope 付き issue
    area: backend
    coversAcIds: [AC-FEAT-001]
    scope:
      include: ['src/pipeline/**', 'test/**']
      exclude: ['test/acceptance-harness/**']
  - key: ISSUE-FEAT-002
    title: scope 無し issue
    area: frontend
    coversAcIds: [AC-FEAT-002]
`;
    const specPath = signedSpecWithIssues(store, 'feat', ['AC-FEAT-001', 'AC-FEAT-002'], withScope);
    draftContracts(store, specPath);

    const scoped = store.db.issues.find((i) => i.coversAcIds.includes('AC-FEAT-001'))!;
    expect(scoped.contract!.scope).toEqual({
      include: ['src/pipeline/**', 'test/**'],
      exclude: ['test/acceptance-harness/**'],
    });

    // The grounded latent bug: coversAcIds used to land in scope.include, where scope_check
    // globs them against changed FILES — matching nothing, so any real change violated scope.
    const unscoped = store.db.issues.find((i) => i.coversAcIds.includes('AC-FEAT-002'))!;
    expect(unscoped.contract!.scope.include).toEqual([]); // unrestricted, NOT ['AC-FEAT-002']
    expect(unscoped.contract!.scope.exclude).toEqual([]);
  });

  it('AC-CONTRACT-006: drafts only the named spec\'s issues, leaving other specs untouched', () => {
    const store = tmpStore('c006');
    const specA = signedSpecWithIssues(store, 'feat-a', ['AC-FEAT-001', 'AC-FEAT-002'], TWO_ISSUES);
    const otherIssues = `issues:\n  - key: ISSUE-OTHER-001\n    title: 別 spec の issue\n    area: backend\n    coversAcIds: [AC-OTHER-001]\n`;
    signedSpecWithIssues(store, 'feat-b', ['AC-OTHER-001'], otherIssues);

    draftContracts(store, specA);

    for (const issue of store.db.issues) {
      if (issue.specPath === specA) {
        expect(issue.status).toBe('contract-drafted');
      } else {
        expect(issue.status).toBe('planned'); // feat-b untouched
        expect(issue.contract).toBeNull();
      }
    }
  });
});
