import { describe, it, expect } from 'vitest';
import { parseSpecScenarios, parseAcceptance } from '../src/authoring/source.js';
import { buildApprovedSpecRef } from '../src/authoring/sign.js';
import { recheckSpec } from '../src/authoring/recheck.js';

// Two ACs, signed. Blob SHAs are stand-ins we control directly so the coarse
// stage is exercised without touching git.
const SPEC = `## A

**受け入れ基準**

- **[AC-R-001] 正常系: 保存**
  - Given 画面
  - When 保存
  - Then 永続化される

- **[AC-R-002] 異常系: 警告**
  - Given 画面
  - When 不正
  - Then 警告される

**完了条件**

- 自動テスト: 2
`;

const ACC = `verifications:
  AC-R-001:
    severity: blocker
    method: unit_test
    expected: ["保存できる"]
  AC-R-002:
    severity: major
    method: unit_test
    expected: ["警告が出る"]
`;

const SPEC_BLOB = 'spec-blob-at-signing';
const ACC_BLOB = 'acc-blob-at-signing';

function signed() {
  const scenarios = parseSpecScenarios(SPEC);
  const verifications = parseAcceptance(ACC);
  return buildApprovedSpecRef({
    scenarios,
    verifications,
    git: { signedCommitSha: 'c0ffee', specBlobGitSha: SPEC_BLOB, acceptanceBlobGitSha: ACC_BLOB },
  });
}

describe('recheckSpec (AUTH-D two-stage)', () => {
  it('stage ① fast path: matching blob SHAs report no drift, status approved', () => {
    const r = recheckSpec({
      approved: signed(),
      specText: SPEC,
      acceptanceText: ACC,
      currentSpecBlobSha: SPEC_BLOB,
      currentAcceptanceBlobSha: ACC_BLOB,
    });
    expect(r.coarseChanged).toBe(false);
    expect(r.status).toBe('approved');
    expect(r).toMatchObject({ changed: [], added: [], removed: [] });
  });

  it('AC-AUTH-009: editing one AC drifts only it and drops status', () => {
    const edited = SPEC.replace('Then 永続化される', 'Then 何もしない');
    const r = recheckSpec({
      approved: signed(),
      specText: edited,
      acceptanceText: ACC,
      currentSpecBlobSha: 'edited', // coarse must trip
      currentAcceptanceBlobSha: ACC_BLOB,
    });
    expect(r.coarseChanged).toBe(true);
    expect(r.changed).toEqual(['AC-R-001']);
    expect(r.retainedApprovedAcIds).toEqual(['AC-R-002']);
    expect(r.status).toBe('co-authoring');
  });

  it('AC-AUTH-010: adding an AC downgrades status, leaves signed ACs intact', () => {
    const added = SPEC.replace(
      '**完了条件**',
      '- **[AC-R-003] 境界: 上限**\n  - Given 画面\n  - When 上限\n  - Then 弾く\n\n**完了条件**',
    );
    const acc = ACC + '  AC-R-003:\n    severity: minor\n    method: unit_test\n    expected: ["弾く"]\n';
    const r = recheckSpec({
      approved: signed(),
      specText: added,
      acceptanceText: acc,
      currentSpecBlobSha: 'edited',
      currentAcceptanceBlobSha: 'edited',
    });
    expect(r.added).toEqual(['AC-R-003']);
    expect(r.retainedApprovedAcIds).toEqual(['AC-R-001', 'AC-R-002']);
    expect(r.status).toBe('co-authoring');
  });

  it('AC-AUTH-011: deleting an AC prunes it and keeps the rest approved', () => {
    const spec = `## A\n\n**受け入れ基準**\n\n- **[AC-R-001] 正常系: 保存**\n  - Given 画面\n  - When 保存\n  - Then 永続化される\n\n**完了条件**\n`;
    const acc = `verifications:\n  AC-R-001:\n    severity: blocker\n    method: unit_test\n    expected: ["保存できる"]\n`;
    const r = recheckSpec({
      approved: signed(),
      specText: spec,
      acceptanceText: acc,
      currentSpecBlobSha: 'edited',
      currentAcceptanceBlobSha: 'edited',
    });
    expect(r.removed).toEqual(['AC-R-002']);
    expect(r.changed).toEqual([]);
    expect(r.status).toBe('approved'); // remaining coverage complete -> no re-sign
  });
});
