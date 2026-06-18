# M20 オーサリング層 / spec.md 契約 仕様

- 正本参照: ADR-0001（[decisions/0001](../decisions/0001-authoring-execution-split.md)）,
  REQUIREMENTS.md §7（intake 部分）, §11（Issue Contract 関連 FR）
- 参考実装: [templates/feature-spec.md](../../../templates/feature-spec.md),
  [templates/manual-requirements.md](../../../templates/manual-requirements.md),
  `src/planning/planner.ts`（**置換**方針）
- 仕様状態: 下書き（v2 改訂中。敵対レビュー 2026-06-15 で drift 検知・gitSha 永続先・status 粒度の欠陥を検出し再修正）
- 最終更新: 2026-06-15

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

### 3.3 spec.md frontmatter（meta・機械パース可能な署名記録）

meta は **YAML frontmatter** で持つ（AUTH-FR-001 機械パース可能。Markdown テーブルより確実）。
`approval.approvedAcIds` が**署名の SoT**。`status` はそこから導出する集約値（後述）。

```text
---
featureId:   <FEATURE>                # AC/MR ID 接頭辞
area:        frontend|backend|fullstack|infra
epicId:      <EPIC-ID>
status:      draft|co-authoring|approved   # 派生値: approvedAcIds ⊇ 現 AC 全集合 なら approved
approval:
  approvedAcIds[]:  署名済みの AC-ID 集合（= 署名の SoT。部分 drift はここから外す: O4）
  approvedAt:       ISO8601
  approvedBy:       署名者の人間可読表示（補助。真正性は署名 commit の author が担保）
---
```

> **status は派生値（A3）**: `status` は epic 単位の単一値だが、署名は AC 単位で動く（O4 の部分再署名）。
> よって `status` は `approval.approvedAcIds` から導出する: `approvedAcIds ⊇ spec.md の現 AC 全集合`
> なら `approved`、真サブセットなら `co-authoring`、空/未着手なら `draft`。部分 drift は drift した
> AC-ID を `approvedAcIds` から除くだけで表現でき、status は自動的に `co-authoring` へ落ちる。
> approval ブロックを消さないので、未変更 AC の署名証跡は保持される。
>
> **approvedBy は補助表示（A4）**: frontmatter は repo 内テキストで誰でも編集可能ゆえ、これ単体では
> 署名の真正性を証明しない。真正性は **署名 commit（status:approved を含む commit）の author/committer**
> （必要なら署名付き commit）が担保し、`approvedBy` はその人間可読の表示にすぎない。
>
> **版固定 ref を frontmatter に置かない理由**: 署名 commit の SHA はその commit を作るまで確定せず、
> 内容 blob SHA も frontmatter に自己参照で焼くと内容が変わる。版固定 ref は §3.4 の永続先に置く。

### 3.4 ApprovedSpecRef（contract-approved の実体・最初の永続先）

```text
ApprovedSpecRef:
  epicId:                 epic 識別子
  approvalCommitSha:      署名 commit（status:approved を含む commit）の SHA。真正性 / 監査用
  behaviorRef:            {path, gitSha}  spec.md の版固定 ref。gitSha は blob SHA（ADR-0001 D8）
  verificationRef:        {path, gitSha}  acceptance.yaml の版固定 ref。gitSha は blob SHA（ADR-0001 D8）
  manualRequirementsRef?: {path, gitSha}  manual-requirements.md の版固定 ref。gitSha は blob SHA（存在する場合）
  approvedAcIds[]:        署名済み AC-ID 集合（= frontmatter.approval.approvedAcIds）
  acFingerprints:         AC-ID → 署名時点の内容ハッシュ（spec.behavior + acceptance.verification）。AC 単位 drift の基準
  approvedAt:             署名日時（= frontmatter.approval.approvedAt）
```

> **最初の永続先 = epic 状態オブジェクト（M18 store）（A2）**: 署名 commit の SHA と版固定 ref は
> frontmatter に焼けない（自己参照）。かつ issue は decomposed 後（M21→M05→M03 の
> 下流）にしか生まれないため、**issue を最初の置き場にできない**（M21 着手時には issue が無い）。
> よって M20 tooling が署名直後に `approvalCommitSha` と各ファイルの blob SHA を取得し、ApprovedSpecRef を
> **epic 状態オブジェクト（M18 store）に書く**。これが issue 生成前の権威ある記録。M21 はここから
> `behaviorRef` / `verificationRef` / `manualRequirementsRef` を読んで pin する。
> issue 投稿時（M03）に issue の `specRef` へ **転記**される（O2「issue が承認記録」は転記後の話）。
> `approvalCommitSha` と各 blob SHA は承認イベントのメタ（どの版を承認したか）であり、実行 SoT 側（D5）に属する。
>
> **acFingerprints が AC 単位 drift の基準**: path 単位 diff だけでは「どの AC が変わったか」を返せない
> ため（§4 参照）、署名時に AC-ID ごとの内容ハッシュを固定し、AC 単位の構造 diff の基準とする。

## 4. 振る舞い / 処理フロー

協業ループ（状態: `draft → co-authoring → approved`）:

1. 人間が機能の概要・scope・前提・受け入れ要件の **behavior** を spec.md に起票（`draft`）。
2. AI が各 AC-ID に `verification`（method + expected）を acceptance.yaml で提案し、**自動採点可否を分類**（`co-authoring`）。
3. 自動採点できない要件は manual-requirements.md（MR）へ振り分け（受け入れ要件に混ぜない）。
4. 人間が verification を確定。全受け入れ要件が自動採点 method を持つ状態にする。
5. 人間が署名。tooling が署名 commit の SHA、各ファイルの blob SHA、AC 単位の内容ハッシュを
   ApprovedSpecRef に固定（§3.4）。
   `approvedAcIds` が全 AC を覆い、status は派生的に `approved` になる。
6. 設計・分解は **M21 Design Planner** が担う（本層の境界外）。M21 が自動スライス、人間 override は任意（ADR-0001 D10/D13）。

drift 検知は**二段**（A1。path 単位 diff だけでは「どの AC が変わったか」を返せないため）:

1. **粗検知（path 単位）**: ApprovedSpecRef の各 ref の blob SHA と HEAD の blob SHA を比較し、
   spec.md / acceptance.yaml が変わったかを検知（変更有無のみ）。
2. **AC 単位の構造 diff**: 変更ありなら両ファイルを構造パースし、AC-ID ごとに現内容ハッシュ
   （behavior + verification）を ApprovedSpecRef の `acFingerprints` と比較。**ハッシュが変わった AC-ID
   のみ**を `approvedAcIds` から外す（→ status が `co-authoring` に落ち、再署名を要求）。

drift の各ケースの扱い:

- **behavior / verification の中身だけ変更**（AC-ID 行は不変）: 構造 diff がその AC-ID のハッシュ差を検出 → 当該 AC を再署名対象に。
- **AC 新規追加**: 新 AC-ID は `approvedAcIds` に無く、`approvedAcIds ⊉ 現 AC 全集合` となり status が `co-authoring` に落ちる（被覆漏れとして必ず署名要求）。
- **AC 削除**: 削除 AC-ID を `approvedAcIds`・`acFingerprints` から除去。M21 側の孤児スライス検知（[design-planner.md](design-planner.md) FR-010）と連動。

## 5. 機能要件 (FR)

新規採番 `AUTH-FR-xxx`。

- **AUTH-FR-001 構造**: spec.md は meta + scope + acceptanceCriteria(behavior) + redLines を機械パース可能に持つ。
- **AUTH-FR-002 AC-ID 安定性**: 一度振った AC-ID / MR-ID は不変。renumber・再利用を禁止。AC-ID は spec.md と acceptance.yaml の join キー。
- **AUTH-FR-003 自動採点制約**: acceptance.yaml の `method` は自動採点集合のみ（`manual` 禁止）。
- **AUTH-FR-004 manual 分離**: 非自動要件は manual-requirements.md に分離し `tier` を付す。
- **AUTH-FR-005 協業 / ファイル分離**: `behavior` は人間が spec.md に記述、`verification` は AI が acceptance.yaml に提案 + 人間確定（O1 反転: D15）。
- **AUTH-FR-006 署名ゲート / status 派生**: `status` は `approval.approvedAcIds` から導出する集約値
  （`approvedAcIds ⊇ 現 AC 全集合` で `approved`）。署名の SoT は `approvedAcIds`（A3）。
- **AUTH-FR-007 gitSha pin / 永続先**: 署名 commit の SHA（真正性 / 監査用）と各ファイルの blob SHA
  （`behaviorRef` / `verificationRef` / `manualRequirementsRef`）、AC 単位ハッシュ（`acFingerprints`）を
  ApprovedSpecRef に固定し、**epic 状態オブジェクト（M18 store）を最初の永続先**とする。issue へは転記（A2）。
- **AUTH-FR-008 drift 二段検知**: (1) path 単位で spec.md / acceptance.yaml の変更有無を検知 →
  (2) AC 単位の構造 diff（現ハッシュ vs `acFingerprints`）で変更 AC-ID を特定し `approvedAcIds` から外す（A1）。
- **AUTH-FR-009 スライス源**: `subArea` を分割境界ヒントとして M21 Design Planner へ提供（1:1 では issue でない: β）。
- **AUTH-FR-010 AC ⇔ acceptance 被覆**: spec.md の AC-ID 集合と acceptance.yaml のキー集合は**双方向一致**
  （過不足ゼロ）。署名ゲートの機械チェックに含める（Tier D 指摘の昇格）。

## 6. 非機能要件

- **人間可読性**: spec.md は人間が編集する Markdown を維持。grader 向け詳細（verification）は acceptance.yaml に逃がす（D15）。
- **Git 追跡**: spec.md / acceptance.yaml / manual-requirements.md はリポジトリ内に置き Git 履歴に乗せる。
- **入力決定性**: 同一 blob `gitSha` は同一の resolve 入力を保証（projection の決定性は M05、入力の安定性は本層）。
- **skill 駆動**: 本層の協業は skill として実装（既存 `draft-spec` を本出力形に拡張/置換: D19）。

## 7. 不変条件・禁止事項 (red lines)

- 実行層（Coordinator / Generator）が spec.md を書き換えない。SoT は人間。
- 実装後に AC を緩めない。
- AC-ID / MR-ID を renumber・再利用しない。
- 受け入れ要件に `manual` メソッドを混ぜない（必ず MR へ）。

## 8. 受け入れ条件 (testable)

- サンプル spec.md + acceptance.yaml（例: octolink `stake/` 相当）がパースでき、AC-ID で join できる。
- 受け入れ要件と manual 要件の混在がゼロ（全 AC が acceptance.yaml に自動採点 method を持つ）。
- `approved` な spec.md / acceptance.yaml から版固定 ref + acFingerprints 付き ApprovedSpecRef を生成し、**issue 生成前に
  epic 状態オブジェクトへ永続化**できる（M21 がそこから gitSha を読める）。
- spec.md の AC behavior を1つ変更 → AC 単位の構造 diff が**その AC-ID のみ**を再署名対象にし、
  未変更 AC の署名は保持される（path 単位検知だけでは達成不能なことを検証）。
- AC を1つ追加 → status が派生的に `co-authoring` に落ち、被覆漏れとして署名要求が立つ。

## 9. 既存実装とのギャップ / 移行方針

- `src/planning/planner.ts`: seed YAML（contract 全埋め込み）→ リポジトリ内 spec.md + acceptance.yaml +
  M05 の resolve に**置換**。`SeedRoadmap` schema は廃止 / 再定義。
- `Issue.contract` 埋め込み廃止 → `specRef` 参照（M05 / M18 と連動）。
- 現状の `ready-for-contract → contract-drafted` 即時遷移（`planFromSeed` L74-76）を、
  協業 + 署名ゲート（`draft → co-authoring → approved`）に置換。
- **テンプレート更新（完了 2026-06-15）**: [templates/feature-spec.md](../../../templates/feature-spec.md) を
  O1 反転形に更新済み（meta=YAML frontmatter / 受け入れ要件は behavior+subArea のみ / verification を分離）。
  [templates/acceptance.yaml](../../../templates/acceptance.yaml) を新設（AC-ID キーで verification）。

## 10. 未決事項 / 決定ログ

決定済（ADR-0001）: D4 spec.md=SoT / D6 協業・contract-approved / D7 B 方針 /
D8 specRef 参照・gitSha / D9 状態二段化 / D10 粒度 β / D13 M21 分離 / D15 O1 反転 /
D16 可読性前提 / D19 skill 駆動。

O1-O4 解決済（簡易アプリ通しで確認）:

- **O1 → 反転で確定（D15）**: embedded YAML をやめ、spec.md(behavior) + acceptance.yaml(verification)。
- **O2 → 確定（v2 訂正）**: 署名記録は frontmatter `status`（派生値）+ ApprovedSpecRef。版固定 ref の最初の
  永続先は **epic 状態オブジェクト（M18 store）**。issue は decomposed 後に生まれるので「issue が承認記録」は
  **転記後**の話であり、issue を最初の置き場にはできない（A2 修正）。専用承認 DB なし。
- **O3 → 確定（v2 訂正 / 2026-06-18 追従）**: ApprovedSpecRef は `approvalCommitSha` + ファイル別 blob ref +
  AC 単位ハッシュ。drift は **二段**——path 単位で変更有無 → **AC 単位の構造 diff** で変更 AC-ID を特定。
  「path 単位 diff のみ」では AC-ID を特定不能（A1 修正）。
- **O4 → 確定**: drift 再署名は **変更 AC-ID のサブセットのみ**。`approvedAcIds` から外して表現（A3）。

本セッション改訂（2026-06-15・下書き → 確定 → 敵対レビューで下書きへ差し戻し v2）:

- **frontmatter（§3.3）**: meta=YAML frontmatter。署名 SoT は `approvedAcIds`、`status` は派生値（A3）。
  `approvedBy` は補助表示・真正性は署名 commit author（A4）。
- **ApprovedSpecRef（§3.4）**: `approvalCommitSha` + `behaviorRef` / `verificationRef` / `manualRequirementsRef`
  （各 `{path, gitSha(blob)}`）+ acFingerprints + approvedAcIds。**最初の永続先 = epic 状態
  オブジェクト**（A2）。
- **drift（§4 / AUTH-FR-008）**: 二段検知に修正（A1）。AC ⇔ acceptance 双方向被覆を AUTH-FR-010 に昇格。
- **テンプレート（§9）**: feature-spec.md を O1 反転形に更新・acceptance.yaml 新設。

残 open（本層）: v2 修正の受け入れ条件（§8）を実装で固める。`acFingerprints` のハッシュ対象（behavior +
verification の正規化方法）の確定。M21 への `subArea` 受け渡しは [design-planner.md](design-planner.md) §2 で consume 済み。

**M01 抽出候補（loop 1 通過後・README §8）**: `ApprovedSpecRef`（version-pinned refs + acFingerprints）の
version-pinned Ref 形と、AC-ID / MR-ID の ID 規約は M01 共通契約モデルへ抽出する候補。先に固定しない（ADR D1）。
