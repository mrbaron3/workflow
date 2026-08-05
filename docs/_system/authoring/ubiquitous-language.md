# ユビキタス言語 — authoring コンテキスト

> authoring コンテキストは **spec の WHAT（受け入れ基準）を人間が著述し署名する**こと、および署名後の
> ドリフト検知を所有する。[context-map.md](../../context-map.md) の境界に従う。語はこのコンテキスト内で
> 一貫。追加のみ（`LANG-authoring-NNN` は安定）。

| ID | 用語 | 意味（authoring コンテキスト内で一貫） |
| --- | --- | --- |
| LANG-authoring-001 | Spec | 粒度非依存の**著述・署名単位**: `spec.md` ＋ `acceptance.yaml`。1つの凝集した署名可能 capability（1 spec ≠ 1 epic）。 |
| LANG-authoring-002 | spec.md（オーサリング SoT） | 人間が受け入れ基準の behavior を Given/When/Then で書き、署名する正本。WHAT のみ・HOW を書かない。 |
| LANG-authoring-003 | 受け入れ基準（AC） | spec.md の名前付きシナリオ。安定 `AC-<SPEC>-NNN` を持つ。authoring の最小著述単位（planning の `LANG-planning-005` を、ここでは著述対象として詳説）。 |
| LANG-authoring-004 | acceptance.yaml | AC-ID → verification(method + expected) ＋ severity を分離した grader 向け SoT。`dependsOn`/`supersedes` の構造化メタもここ。 |
| LANG-authoring-005 | 署名 / contract-approved | 人間が WHAT を承認する判断点。spec を `contract-approved` にし、改竄検知可能な版固定（`ApprovedSpecRef`）を産む。 |
| LANG-authoring-006 | ApprovedSpecRef | 署名の実体: spec を指す path ＋署名コミット/blob gitSha ＋ `acFingerprints`（AC 単位）＋ `approvedAcIds` ＋ `systemRefs`。 |
| LANG-authoring-007 | fingerprint | AC の内容ハッシュ。署名時に AC 単位で pin し、後の内容変更（ドリフト）を AC 粒度で検知する鍵。 |
| LANG-authoring-008 | ドリフト / deriveStatus | 署名後に AC が変わったか。status は保存せず、署名 `approvedAcIds` が現在 AC 集合を覆うかから**派生**する。 |
| LANG-authoring-009 | supersedes | この spec の AC が置換する過去 AC-ID。現在仕様を畳む鍵（DOC_LIFECYCLE）。 |
| LANG-authoring-010 | Manual Verification Exclusion | `verification.method: manual`は署名gateで拒否し、signed ACにも別建て`manual-requirements`／`MR-ID` fileにも変換しない。人間のWHAT判断は`LANG-authoring-005`署名として、実装不能・機械判定不能は明示的なhuman gate/escalationとして扱う。現行判定は`apps/agentops/src/authoring/lint.ts`の`checkManualAbsence`が正本。 |
