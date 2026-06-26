import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSpecScenarios, parseAcceptance } from '../src/authoring/source.js';
import { buildApprovedSpecRef, computeAcFingerprints } from '../src/authoring/sign.js';
import { fingerprintAc } from '../src/authoring/fingerprint.js';
import { evaluateDrift } from '../src/authoring/drift.js';

// --- fixtures ----------------------------------------------------------------

const SPEC = `# Demo 受け入れ要件

## サブ機能一覧

| ID | サブ機能 | 優先度 |
| --- | --- | --- |
| DEMO-A | x | 高 |

## DEMO-A

**ユーザーストーリー**

- 誰が: 人間

**受け入れ基準**

- **[AC-DEMO-001] 正常系: 保存できる**
  - Given 入力画面
  - When 保存する
  - Then 永続化される

- **[AC-DEMO-002] 異常系: 失敗で警告**
  - Given 入力画面
  - When 不正値で保存
  - Then 警告が記録される

**非機能要件**

- 性能: 速い
`;

const ACC = `verifications:
  AC-DEMO-001:
    severity: blocker
    method: unit_test
    expected:
      - "保存後に GET で取得できる"
  AC-DEMO-002:
    severity: major
    method: api_test
    expected:
      - "不正値で 4xx"
`;

// --- parser ------------------------------------------------------------------

describe('parseSpecScenarios', () => {
  const scenarios = parseSpecScenarios(SPEC);

  it('extracts one scenario per AC anchor, in document order', () => {
    expect(scenarios.map((s) => s.id)).toEqual(['AC-DEMO-001', 'AC-DEMO-002']);
  });

  it('captures the title + GWT but not the AC-ID token', () => {
    const b = scenarios[0]!.behavior;
    expect(b).toContain('保存できる'); // title
    expect(b).toContain('Given 入力画面');
    expect(b).toContain('Then 永続化される');
    expect(b).not.toContain('AC-DEMO-001'); // identity, not content
  });

  it('stops a scenario at the next section boundary (does not bleed)', () => {
    expect(scenarios[1]!.behavior).toContain('Then 警告が記録される');
    expect(scenarios[1]!.behavior).not.toContain('性能'); // **非機能要件** ends it
  });

  it('ignores bullets that precede any anchor (user story)', () => {
    expect(scenarios.some((s) => s.behavior.includes('誰が'))).toBe(false);
  });
});

describe('parseAcceptance', () => {
  it('parses the verifications map by AC-ID', () => {
    const v = parseAcceptance(ACC);
    expect(Object.keys(v)).toEqual(['AC-DEMO-001', 'AC-DEMO-002']);
    expect(v['AC-DEMO-001']).toEqual({ severity: 'blocker', method: 'unit_test', expected: ['保存後に GET で取得できる'] });
    expect(v['AC-DEMO-002']!.method).toBe('api_test');
  });
});

// --- sign assembly (AC-AUTH-007) ---------------------------------------------

describe('buildApprovedSpecRef (AC-AUTH-007)', () => {
  const scenarios = parseSpecScenarios(SPEC);
  const verifications = parseAcceptance(ACC);
  const git = { signedCommitSha: 'c0ffee', specBlobGitSha: 'aaaa', acceptanceBlobGitSha: 'bbbb' };
  const ref = buildApprovedSpecRef({ scenarios, verifications, git });

  it('pins git facts and approves the full current AC set', () => {
    expect(ref.signedCommitSha).toBe('c0ffee');
    expect(ref.specBlobGitSha).toBe('aaaa');
    expect(ref.acceptanceBlobGitSha).toBe('bbbb');
    expect(ref.approvedAcIds).toEqual(['AC-DEMO-001', 'AC-DEMO-002']);
    expect(ref.systemRefs).toEqual([]); // greenfield
  });

  it('fingerprints each AC over behavior + severity + verification', () => {
    const s = scenarios[0]!;
    const v = verifications['AC-DEMO-001']!;
    expect(ref.acFingerprints['AC-DEMO-001']).toBe(
      fingerprintAc({ behavior: s.behavior, severity: v.severity, method: v.method, expected: v.expected }),
    );
  });

  it('a freshly signed spec shows no drift and derives approved', () => {
    const current = { acIds: scenarios.map((s) => s.id), fingerprints: computeAcFingerprints(scenarios, verifications) };
    const r = evaluateDrift({ approvedAcIds: ref.approvedAcIds, fingerprints: ref.acFingerprints }, current);
    expect(r.changed).toEqual([]);
    expect(r.status).toBe('approved');
  });

  it('editing one AC after signing drifts only that AC (round-trip with the parser)', () => {
    const edited = SPEC.replace('Then 永続化される', 'Then 何もしない');
    const cur = parseSpecScenarios(edited);
    const current = { acIds: cur.map((s) => s.id), fingerprints: computeAcFingerprints(cur, verifications) };
    const r = evaluateDrift({ approvedAcIds: ref.approvedAcIds, fingerprints: ref.acFingerprints }, current);
    expect(r.changed).toEqual(['AC-DEMO-001']);
    expect(r.status).toBe('co-authoring');
  });
});

// --- real-format cross-check against the dogfooded M20 spec ------------------

describe('parser vs the live authoring-layer spec', () => {
  const dir = resolve(process.cwd(), 'docs/specs/authoring-layer');
  const specText = readFileSync(resolve(dir, 'spec.md'), 'utf8');
  const accText = readFileSync(resolve(dir, 'acceptance.yaml'), 'utf8');

  it('extracts exactly the bracketed AC-IDs the signing-gate regex sees, in order', () => {
    const parsed = parseSpecScenarios(specText).map((s) => s.id);
    const regexIds = [...specText.matchAll(/\[(AC-[A-Z0-9]+-\d+)\]/g)].map((m) => m[1]);
    expect(parsed).toEqual(regexIds);
  });

  it('every parsed AC has non-empty behavior and a matching acceptance key', () => {
    const scenarios = parseSpecScenarios(specText);
    expect(scenarios.every((s) => s.behavior.length > 0)).toBe(true);
    expect(new Set(scenarios.map((s) => s.id))).toEqual(new Set(Object.keys(parseAcceptance(accText))));
  });
});
