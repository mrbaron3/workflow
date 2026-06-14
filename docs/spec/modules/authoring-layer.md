# M20 オーサリング層 / spec.md 契約 仕様

- 正本参照: ADR-0001（[decisions/0001](../decisions/0001-authoring-execution-split.md)）,
  REQUIREMENTS.md §7（intake 部分）, §11（Issue Contract 関連 FR）
- 参考実装: [templates/feature-spec.md](../../../templates/feature-spec.md),
  [templates/manual-requirements.md](../../../templates/manual-requirements.md),
  `src/planning/planner.ts`（**置換**方針）
- 仕様状態: 下書き
- 最終更新: 2026-06-14

## 1. 目的とスコープ境界

人間 + AI 協業で **spec.md（オーサリング SoT）** と **manual-requirements.md** を作成し、
人間署名により `contract-approved` を成立させ、Development Department への**入力契約**を
確定する層。全フローの最上流。

担う:

- spec.md / manual-requirements.md の構造（schema）と AC-ID / MR-ID 規約
- 合格基準の協業（人間=behavior、AI=verification 提案）
- 自動採点 AC と非自動要件（manual）の分離（B 方針）
- `contract-approved` 署名ゲートと gitSha pin・drift 検知の意味論

担わない（隣接モジュール）:

- **詳細設計（Tier1 スパイン / Tier2 スライス）と PR サイズ分解** → M21 Design Planner
- spec.md → IssueContract の **resolve 実体** → M05 Issue Contract Planner
- 子 issue へのディスパッチ・状態機械の execution 後半 → M03 Coordinator
- 実装 → M06 Generator
- 自然言語の意図分類・抽象度判定（将来）→ M02 Hermes

## 2. 入力契約 (consumes)

- 人間の機能要求（自然言語 / 既存ドキュメント）。構造化前。
- ロードマップ文脈（vision / principles / 機能間の優先順位）。M04 Roadmap Planner との境界。

## 3. 出力契約 (produces)

### 3.1 spec.md（オーサリング SoT・リポジトリ内・人間可読）

O1 反転（ADR-0001 D15）により、spec.md は **人間可読な AC** のみを持つ。
grader 向けの `verification` は §3.1a の `acceptance.yaml` に分離する。

```text
meta:            featureId, area, epicId, status(draft|co-authoring|approved)
概要:            productGoal / userStory の源泉（自由文）
scope:           include[] / exclude[]
前提条件:        precondition[]
acceptanceCriteria[]:               # 人間可読なチェックリスト
  id:            AC-<FEATURE>-NNN   （安定。不変。acceptance.yaml との join キー）
  severity:      blocker | major | minor
  behavior:      観測可能な振る舞い（人間が記述）
  subArea:       受け入れ要件サブ見出し（= 分割ヒント。1:1 で issue ではない: β）
redLines[]:      実装が絶対にしてはならないこと
```

### 3.1a acceptance.yaml（grader 向け・リポジトリ内・AI 協業で記述）

`verification` を spec.md から分離。AC-ID をキーに join する。

```text
verifications:
  <AC-ID>:
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

### 3.3 ApprovedSpecRef（contract-approved の実体）

issue 投稿時に execution 層へ渡る参照。issue の `specRef` の源泉。

```text
ApprovedSpecRef:
  path:            spec.md のリポジトリ内パス
  gitSha:          署名時点の commit SHA（drift 検知の基準）
  approvedAcIds[]: 署名対象の AC-ID 集合
  approvedAt:      署名日時
```

## 4. 振る舞い / 処理フロー

協業ループ（状態: `draft → co-authoring → approved`）:

1. 人間が機能の概要・scope・前提・受け入れ要件の **behavior** を spec.md に起票（`draft`）。
2. AI が各 AC-ID に `verification`（method + expected）を acceptance.yaml で提案し、**自動採点可否を分類**（`co-authoring`）。
3. 自動採点できない要件は manual-requirements.md（MR）へ振り分け（受け入れ要件に混ぜない）。
4. 人間が verification を確定。全受け入れ要件が自動採点 method を持つ状態にする。
5. 人間が署名 → `approved`。その時点の commit SHA を ApprovedSpecRef に固定。
6. 設計・分解は **M21 Design Planner** が担う（本層の境界外）。M21 が自動スライス、人間 override は任意（ADR-0001 D10/D13）。

drift（署名後に spec.md / acceptance.yaml が変わった場合）:

- approved commit と HEAD を、**spec.md と acceptance.yaml の両ファイル**で path 単位比較。
- 変更された **AC-ID だけ**を `co-authoring` に戻し、再署名を要求（安定 ID ゆえに差分特定が可能）。

## 5. 機能要件 (FR)

新規採番 `AUTH-FR-xxx`。

- **AUTH-FR-001 構造**: spec.md は meta + scope + acceptanceCriteria(behavior) + redLines を機械パース可能に持つ。
- **AUTH-FR-002 AC-ID 安定性**: 一度振った AC-ID / MR-ID は不変。renumber・再利用を禁止。AC-ID は spec.md と acceptance.yaml の join キー。
- **AUTH-FR-003 自動採点制約**: acceptance.yaml の `method` は自動採点集合のみ（`manual` 禁止）。
- **AUTH-FR-004 manual 分離**: 非自動要件は manual-requirements.md に分離し `tier` を付す。
- **AUTH-FR-005 協業 / ファイル分離**: `behavior` は人間が spec.md に記述、`verification` は AI が acceptance.yaml に提案 + 人間確定（O1 反転: D15）。
- **AUTH-FR-006 署名ゲート**: 全受け入れ要件の署名で `contract-approved` が成立。
- **AUTH-FR-007 gitSha pin**: 署名時の commit SHA を ApprovedSpecRef に固定。
- **AUTH-FR-008 drift 検知**: spec.md / acceptance.yaml の両ファイル変更を path 単位で検知し、変更 AC-ID に再署名フラグを立てる。
- **AUTH-FR-009 スライス源**: `subArea` を分割境界ヒントとして M21 Design Planner へ提供（1:1 では issue でない: β）。

## 6. 非機能要件

- **人間可読性**: spec.md は人間が編集する Markdown を維持。grader 向け詳細（verification）は acceptance.yaml に逃がす（D15）。
- **Git 追跡**: spec.md / acceptance.yaml / manual-requirements.md はリポジトリ内に置き Git 履歴に乗せる。
- **入力決定性**: 同一 `gitSha` は同一の resolve 入力を保証（projection の決定性は M05、入力の安定性は本層）。
- **skill 駆動**: 本層の協業は skill として実装（既存 `draft-spec` を本出力形に拡張/置換: D19）。

## 7. 不変条件・禁止事項 (red lines)

- 実行層（Coordinator / Generator）が spec.md を書き換えない。SoT は人間。
- 実装後に AC を緩めない。
- AC-ID / MR-ID を renumber・再利用しない。
- 受け入れ要件に `manual` メソッドを混ぜない（必ず MR へ）。

## 8. 受け入れ条件 (testable)

- サンプル spec.md + acceptance.yaml（例: octolink `stake/` 相当）がパースでき、AC-ID で join できる。
- 受け入れ要件と manual 要件の混在がゼロ（全 AC が acceptance.yaml に自動採点 method を持つ）。
- `approved` な spec.md から gitSha 付き ApprovedSpecRef を生成できる。
- spec.md / acceptance.yaml を編集 → drift 検知が、変更された AC-ID にのみ再署名フラグを立てる。

## 9. 既存実装とのギャップ / 移行方針

- `src/planning/planner.ts`: seed YAML（contract 全埋め込み）→ リポジトリ内 spec.md + acceptance.yaml +
  M05 の resolve に**置換**。`SeedRoadmap` schema は廃止 / 再定義。
- `Issue.contract` 埋め込み廃止 → `specRef` 参照（M05 / M18 と連動）。
- 現状の `ready-for-contract → contract-drafted` 即時遷移（`planFromSeed` L74-76）を、
  協業 + 署名ゲート（`draft → co-authoring → approved`）に置換。
- **テンプレート更新（要対応）**: [templates/feature-spec.md](../../../templates/feature-spec.md) は
  受け入れ要件に embedded YAML（verification 込み）を持つ旧 O1 形式。**O1 反転（D15）に伴い、
  spec.md は behavior のみ・verification を `templates/acceptance.yaml`（新規）へ分離する形に改める**。

## 10. 未決事項 / 決定ログ

決定済（ADR-0001）: D4 spec.md=SoT / D6 協業・contract-approved / D7 B 方針 /
D8 specRef 参照・gitSha / D9 状態二段化 / D10 粒度 β / D13 M21 分離 / D15 O1 反転 /
D16 可読性前提 / D19 skill 駆動。

O1-O4 解決済（簡易アプリ通しで確認）:

- **O1 → 反転で確定（D15）**: embedded YAML をやめ、spec.md(behavior) + acceptance.yaml(verification)。
- **O2 → 確定**: 署名 = issue に `specRef`(path+gitSha) を焼く（issue が承認記録）+ spec.md frontmatter `status: approved`。専用承認 DB なし。
- **O3 → 確定**: ApprovedSpecRef は **commit SHA**。drift は `approved..HEAD` の **path 単位 diff**。
- **O4 → 確定**: drift 再署名は **変更 AC-ID のサブセットのみ**。

残 open（本層）:

- ApprovedSpecRef / frontmatter `status` の正確なスキーマ確定。
- テンプレート更新（§9）と `templates/acceptance.yaml` 新設。
