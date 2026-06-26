# M20 オーサリング層 / spec.md 契約 仕様

- 正本参照: ADR-0001（[0001](../decisions/0001-authoring-execution-split.md)）,
  **ADR-0004（[0004](../decisions/0004-layered-design-and-global-review.md) D31/D35・system 層参照 / 文書形式）**,
  REQUIREMENTS.md §7（intake 部分）, §11
- 参考実装: [templates/feature-spec.md](../../../templates/feature-spec.md),
  [templates/acceptance.yaml](../../../templates/acceptance.yaml),
  [templates/manual-requirements.md](../../../templates/manual-requirements.md), `src/planning/planner.ts`（**置換**）
- 仕様状態: 下書き（受け入れ基準を Given/When/Then 形式に・frontmatter 廃止・採番/整合をコード強制へ改訂）
- 最終更新: 2026-06-18

## 1. 目的とスコープ境界

人間 + AI 協業で **spec.md（オーサリング SoT）** と **acceptance.yaml** / **manual-requirements.md** を作成し、
人間署名により `contract-approved` を成立させ、Development Department への**入力契約**を確定する層。全フローの最上流。

担う:

- spec.md（受け入れ基準を Given/When/Then で）/ acceptance.yaml / manual-requirements.md の構造と AC-ID / MR-ID 規約
- 合格基準の協業（人間 = 受け入れ基準の behavior、AI = severity + verification 提案）
- 自動採点 AC と非自動要件（manual）の分離
- `contract-approved` 署名ゲートと gitSha pin・drift 検知の意味論
- **AC-ID の採番・整合（被覆・renumber 禁止）をコードで強制**（特定 skill に依存しない）

担わない（隣接モジュール）:

- **ドメインマップ / データ設計 / アーキ（system 層）の著述** → 設計立案役（本層は system 層を**固定制約として
  参照**するのみ・埋め込まない・ADR-0004 D31）
- 詳細設計（system / spec / slice 三層）と PR サイズ分解 → 設計立案役
- spec.md → IssueContract の resolve 実体 → M05
- 子 issue へのディスパッチ・状態機械の後半 → M03 Coordinator
- 実装 → M06 Generator
- 自然言語の意図分類・抽象度判定（将来）→ M02 Hermes

## 2. 入力契約 (consumes)

- 人間の機能要求（自然言語 / 既存ドキュメント）。構造化前。
- **system 層成果物（`_system/domain-map.md` 等）**: ドメイン概念・ユビキタス言語・業務ステータス・データ/アーキの
  全体共有事項を**固定制約として参照**する（存在する場合。greenfield 初回は未整備で、設計層が seed する）。
- ロードマップ文脈（vision / principles / 機能間の優先順位）。M04 Roadmap Planner との境界。

## 3. 出力契約 (produces)

人間が所有・編集する文書はリッチ Markdown（ADR-0004 D35）。**frontmatter は持たない**（meta・署名は
spec 状態オブジェクト ＝ ApprovedSpecRef が持つ）。

### 3.1 spec.md（オーサリング SoT・リポジトリ内・人間可読）

受け入れ基準は **名前付き Given/When/Then シナリオ**で書く（フラットなチェックリストや YAML でなく）。
各シナリオに安定 AC-ID を付す。grader 向けの verification は acceptance.yaml に分離する。

```text
# <機能名> 受け入れ要件
（冒頭に WHAT/HOW 境界の明記 + system 層を固定制約として参照する旨）

## サブ機能一覧            表: ID | サブ機能 | 優先度（= 分割境界ヒント。Design Planner が使う）

## <サブ機能>
  ユーザーストーリー       誰が / 何を / なぜ
  事前条件                 成立を前提とする状態・他機能・system 層の固定制約
  受け入れ基準             名前付き Given/When/Then シナリオ。各に AC-ID:
                            - [AC-<FEATURE>-NNN] <正常/異常/耐障害性>: <名前>
                                Given <前提> / When <操作> / Then <観測可能な結果>
  非機能要件               性能 / セキュリティ / 可観測性（自動採点不能は manual へ）
  完了条件                 自動テスト / SLO / デモ（人間の検証宣言）

## レッドライン           実装が絶対にしてはならないこと
```

### 3.1a acceptance.yaml（grader 向け・リポジトリ内・AI 協業で記述）

`severity` と `verification` を AC-ID をキーに持つ。

```text
verifications:
  <AC-ID>:
    severity:    blocker | major | minor          # blocking 判定に使う
    method:      自動採点メソッドのみ（build|typecheck|unit_test|api_test|
                 db_state_check|playwright|secrets_scan|scope_check|llm_rubric）
    expected[]:  grader が判定できる具体値（AI が協業で確定）
```

### 3.2 manual-requirements.md（要審査要件票・別管理）

```text
manualRequirements[]:
  id:           MR-<FEATURE>-NNN   （AC とは別系列・安定）
  severity:     blocker | major | minor
  requirement:  満たすべき性質
  tier:         audit | static_analysis | human_review | integration_test
  verifier:     確認主体
  evidence:     証跡
```

### 3.3 meta・署名の永続先（frontmatter を持たない）

spec.md は frontmatter を持たない（実物のプロダクト spec も持たない・可読性のため）。meta（featureId / area /
specId）と署名状態（status / approvedAcIds）は **spec 状態オブジェクト（M18 store）が持つ**。`status` は
`approvedAcIds` から導出する集約値（`approvedAcIds ⊇ 現 AC 全集合` で `approved`）。featureId は AC-ID の接頭辞・
ディレクトリ名から導出できる。

### 3.4 ApprovedSpecRef（contract-approved の実体・最初の永続先 = spec 状態オブジェクト）

```text
ApprovedSpecRef:
  specId
  featureId / area                     # meta（frontmatter でなくここが持つ）
  approvalCommitSha:                   # 署名 commit の SHA。真正性 / 監査用
  behaviorRef:       {path, gitSha}    # spec.md の版固定 ref。gitSha は blob SHA
  verificationRef:   {path, gitSha}    # acceptance.yaml の版固定 ref
  manualRequirementsRef?: {path, gitSha}
  systemRefs[]:      {artifact, elementId, gitSha}   # 参照した system 層の固定制約（版固定）
  approvedAcIds[]:                     # 署名済み AC-ID 集合（= 署名の SoT）
  acFingerprints:                      # AC-ID → 署名時の内容ハッシュ（GWT behavior + severity + verification）
  approvedAt
```

> 署名 commit の SHA・blob SHA は frontmatter に自己参照で焼けず、issue は decomposed 後にしか生まれないため、
> **spec 状態オブジェクトを最初の永続先**とする。issue 投稿時（M03）に issue の `specRef` へ転記される。
> `acFingerprints` のハッシュ対象は **GWT シナリオ（Given/When/Then）+ severity + verification** で、AC 単位
> drift の基準。

## 4. 振る舞い / 処理フロー

協業ループ（status: `draft → co-authoring → approved`。status は派生値）:

1. 人間が機能の概要・サブ機能・ユーザーストーリー・事前条件・受け入れ基準（**Given/When/Then**）・完了条件を
   spec.md に起票する。**system 層の固定制約を参照**し、ドメイン/データを重複させない（`draft`）。
2. AI が各 AC-ID に `severity` と `verification`（method + expected）を acceptance.yaml で提案し、**自動採点可否を
   分類**する（`co-authoring`）。
3. 自動採点できない要件は manual-requirements.md（MR）へ振り分け（受け入れ基準に混ぜない）。
4. 人間が severity / verification を確定。全受け入れ基準が自動採点 method を持つ状態にする。
5. **コードが整合を検証**（AC-ID の存在・renumber/再利用なし・spec.md と acceptance.yaml の双方向被覆）。違反は
   署名ゲートで落とす。
6. 人間が署名。**コード**が署名 commit の SHA・各ファイルの blob SHA・AC 単位ハッシュを ApprovedSpecRef に固定し、
   spec 状態オブジェクトへ書く。`approvedAcIds` が全 AC を覆い status は派生的に `approved`。
7. 設計・分解は設計立案役が担う（本層の境界外）。

drift 検知は**二段**:

1. **粗検知（path 単位）**: ApprovedSpecRef の各 ref の blob SHA と HEAD を比較し、spec.md / acceptance.yaml の
   変更有無を検知。
2. **AC 単位の構造 diff**: 変更ありなら両ファイルを構造パースし、AC-ID ごとに現ハッシュ（GWT behavior + severity +
   verification）を `acFingerprints` と比較。**ハッシュが変わった AC-ID のみ**を `approvedAcIds` から外す（→ status が
   `co-authoring` に落ち再署名を要求）。

drift の各ケース: GWT/severity/verification の中身変更 → 当該 AC を再署名対象に。AC 新規追加 → 被覆漏れで status
降格。AC 削除 → `approvedAcIds`/`acFingerprints` から除去・設計立案役の孤児検知と連動。

## 5. 機能要件 (FR)

`AUTH-FR-xxx`。

- **AUTH-FR-001 構造**: spec.md は サブ機能一覧 + 各サブ機能（ユーザーストーリー / 事前条件 / 受け入れ基準[GWT] /
  非機能 / 完了条件）+ レッドラインを持つ。frontmatter は持たない。各受け入れ基準シナリオは **機械抽出可能な
  AC-ID** を1つ持つ。
- **AUTH-FR-002 AC-ID 安定性**: 一度振った AC-ID / MR-ID は不変。renumber・再利用を禁止。AC-ID は spec.md と
  acceptance.yaml の join キー。
- **AUTH-FR-003 自動採点制約**: acceptance.yaml の `method` は自動採点集合のみ（`manual` 禁止）。
- **AUTH-FR-004 manual 分離**: 非自動要件は manual-requirements.md に分離し `tier` を付す。
- **AUTH-FR-005 協業 / ファイル分離**: 受け入れ基準（GWT behavior）は人間が spec.md に記述、`severity` +
  `verification` は AI が acceptance.yaml に提案 + 人間確定。
- **AUTH-FR-006 署名ゲート / status 派生**: `status` は spec 状態オブジェクトの `approvedAcIds` から導出する集約値
  （`approvedAcIds ⊇ 現 AC 全集合` で `approved`）。署名の SoT は `approvedAcIds`。
- **AUTH-FR-007 gitSha pin / 永続先**: 署名 commit の SHA・各ファイルの blob SHA・AC 単位ハッシュ・参照した
  system 要素を ApprovedSpecRef に固定し、**spec 状態オブジェクトを最初の永続先**とする。issue へは転記。
- **AUTH-FR-008 drift 二段検知**: path 単位で変更有無 → AC 単位の構造 diff（現ハッシュ vs `acFingerprints`）で
  変更 AC-ID を特定し `approvedAcIds` から外す。ハッシュ対象は GWT behavior + severity + verification。
- **AUTH-FR-009 分割ヒント**: サブ機能一覧（ID + 優先度）を分割境界ヒントとして設計立案役へ提供（1:1 で issue
  ではない: β）。
- **AUTH-FR-010 AC ⇔ acceptance 被覆**: spec.md の AC-ID 集合と acceptance.yaml のキー集合は**双方向一致**。
  署名ゲートの機械チェックに含める。
- **AUTH-FR-011 system 層参照（非埋め込み）**: ドメイン/データ/業務ステータス等の全体共有事項は system 層を
  参照し、spec.md に重複させない。参照した system 要素は ApprovedSpecRef の `systemRefs` に版固定で記録する
  （ADR-0004 D31）。
- **AUTH-FR-012 完了条件**: 各サブ機能は完了条件（自動テスト / SLO / デモ等の人間可読な検証宣言）を持つ。
- **AUTH-FR-013 採番・整合のコード強制**: AC-ID の存在・renumber/再利用禁止・双方向被覆・manual 不在を、
  **決定的コード**（署名ゲート / lint / pre-commit）で強制する。特定 skill に依存しない（ADR-0003 D28・本層は
  AI 補助 + コード強制）。任意で未採番シナリオへ high-water-mark 連番補完を行う純テキスト変換を持ってよい。

## 6. 非機能要件

- **人間可読性**: spec.md は人間が編集する Markdown（図・表・GWT 可）。grader 向け詳細（severity / verification）は
  acceptance.yaml に逃がす。
- **AI 補助 + コード強制（旧 skill 駆動を置換）**: 著述は人間 + 任意の AI 補助で行い、**契約形式・自動採点・
  AC-ID 整合の強制はコード（決定的 validation）**が担う。特定 skill（旧 draft-spec）を必須にしない。これは
  ADR-0001 D19 を更新する（§10）。
- **Git 追跡**: spec.md / acceptance.yaml / manual-requirements.md はリポジトリ内に置き Git 履歴に乗せる。
- **入力決定性**: 同一 blob `gitSha` は同一の resolve 入力を保証。

## 7. 不変条件・禁止事項 (red lines)

- 実行層（Coordinator / Generator）が spec.md を書き換えない。SoT は人間。
- 実装後に受け入れ基準を緩めない。
- AC-ID / MR-ID を renumber・再利用しない。
- 受け入れ基準に `manual` メソッドを混ぜない（必ず MR へ）。
- spec.md に frontmatter を持たせない（meta・署名は spec 状態オブジェクト）。
- ドメイン/データ/アーキを spec.md に**埋め込まない**（system 層を参照する・ADR-0004 D31）。

## 8. 受け入れ条件 (testable)

- サンプル spec.md（GWT 受け入れ基準・例: rin 決済相当）＋ acceptance.yaml がパースでき、AC-ID で join できる。
- 受け入れ基準と manual 要件の混在がゼロ（全 AC が acceptance.yaml に自動採点 method を持つ）。
- `approved` な spec.md / acceptance.yaml から版固定 ref + acFingerprints + systemRefs 付き ApprovedSpecRef を
  生成し、**issue 生成前に spec 状態オブジェクトへ永続化**できる。
- 受け入れ基準シナリオの GWT を1つ変更（drift）→ AC 単位の構造 diff が**その AC-ID のみ**を再署名対象にし、
  未変更 AC の署名は保持される。
- AC を1つ追加 → status が派生的に `co-authoring` に落ち、被覆漏れとして署名要求が立つ。
- spec.md に frontmatter が無く、ドメイン/データが埋め込まれず system 層を参照していることを検証できる。
- AC-ID の renumber / 重複 / spec↔acceptance の被覆不一致を、署名ゲートのコード検証が**落とす**。

## 9. 既存実装とのギャップ / 移行方針

- `src/planning/planner.ts`: seed YAML（contract 全埋め込み）→ リポジトリ内 spec.md + acceptance.yaml +
  M05 の resolve に**置換**。`SeedRoadmap` schema は廃止 / 再定義。
- `Issue.contract` 埋め込み廃止 → `specRef` 参照（M05 / M18 と連動）。
- **テンプレート（本改訂で更新）**: [templates/feature-spec.md](../../../templates/feature-spec.md) を **GWT 形式**
  （サブ機能一覧 + ユーザーストーリー / 事前条件 / 受け入れ基準[Given/When/Then] + AC-ID / 非機能 / 完了条件 /
  レッドライン・frontmatter なし）に更新。[templates/acceptance.yaml](../../../templates/acceptance.yaml) に
  `severity` を追加。
- **採番・整合の強制 = コード**: AC-ID lint（存在・renumber 禁止・双方向被覆・manual 不在）を署名ゲートに置く
  （新規・決定的コード）。`fingerprint()` は M05 と共有（M01 候補）。

## 10. 未決事項 / 決定ログ

決定済（ADR-0001）: spec.md=SoT / 協業・contract-approved / B 方針 / specRef 参照・gitSha / 状態二段化 /
粒度 β。

本改訂で確定（2026-06-18）:

- **受け入れ基準を Given/When/Then 名前付きシナリオに**（フラットチェックリスト / YAML を廃止）。各シナリオに
  AC-ID。ユーザーストーリー / 事前条件 / 完了条件を節として採用（参考: rin 決済 spec）。
- **frontmatter 廃止**: meta・署名は spec 状態オブジェクト（ApprovedSpecRef）が持つ。
- **severity を acceptance.yaml へ**移動（採点属性ゆえ grader 側）。
- **system 層参照（非埋め込み）**: ドメイン/データ/業務ステータスは system 層を参照（ADR-0004 D31）。AUTH-FR-011。
- **採番・整合をコード強制**（AUTH-FR-013）。**ADR-0001 D19「skill 駆動」を「AI 補助 + コード強制」へ更新**
  （特定 skill を必須にしない・ADR-0003 D28）。この ADR 更新は「skill / コード分担」の決定記録で正式化する（§残 open）。
- acFingerprints のハッシュ対象を GWT behavior + severity + verification に。

残 open:

- ADR-0001 D19 の正式更新（skill 駆動 → AI 補助 + コード強制）を「skill / コード分担」決定記録で行う。
- AC-ID lint・`fingerprint()` 正規化（GWT テキストの正規化方法）の実装確定。
- system 層が未整備（greenfield 初回）のときの参照の扱い（設計層が seed する順序との調整）。

**M01 抽出候補（loop 1 通過後）**: `ApprovedSpecRef`（version-pinned refs + acFingerprints + systemRefs）、
AC-ID / MR-ID の ID 規約、純粋 `fingerprint()`（M20 ↔ M05 共有）。
