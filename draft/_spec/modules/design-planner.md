# M21 Design Planner 仕様

- 正本参照: ADR-0001（[0001](../decisions/0001-authoring-execution-split.md) D10/D13/D14/D16/D17）,
  ADR-0002（[0002](../decisions/0002-independent-design-review.md) D20-D25）,
  ADR-0003（[0003](../decisions/0003-spec-altitude-and-dry.md) D26-D29）,
  **ADR-0004（[0004](../decisions/0004-layered-design-and-global-review.md) D30-D35・設計三層化 / 大域整合）**,
  REQUIREMENTS.md §11/§12
- 参考実装: [agents/issue-planner.md](../../../agents/issue-planner.md)（**分割元**）, `src/planning/planner.ts`（**置換**）
- 仕様状態: 下書き（ADR-0004 で二層 spine+slice → 三層 system/epic/slice に改訂）
- 最終更新: 2026-06-18

## 1. 目的とスコープ境界

`contract-approved` な spec.md（オーサリング SoT）を入力に、**設計を三層（system / epic / slice）で著し**、
PR サイズの issue へ分解する層。AI が著者で人間 override は任意。設計成果物は spawn 前に設計審査役の
**層別・大域整合**の独立審査を通る。本層は設計の**著者・修正者**であり審査者ではない（自己評価しない）。

三層（ADR-0004 D30）:

- **system 層**（ドメインマップ / データ設計 / アーキ）: **全体で単一の生きた SoT**。本層はこれを**読み、
  必要時だけ追加的に拡張するデルタ**を出す。所有は全体であり epic ではない（D31）。
- **epic 層**: 本 epic の設計判断 = どの system 層をどう拡張したか（design-delta）＋ コンポーネント設計。
- **slice 層**: PR サイズの seam 設計。

担う:

- system 層成果物の **追加的拡張デルタ**（ドメイン/データ/アーキへ新要素を additive 追加。既存を
  renumber・巻き戻ししない）
- epic の `design-delta.md`（読んだ／拡張した system 要素の版固定参照 ＋ 追加要素の最小記述 ＋ affectsAcIds）
- コンポーネント/スライス（被覆かつ排他・PR サイズ・依存順）
- `IssueSpawnOrder`（参照集合・版固定）= M05 への handoff 契約
- 設計の human_review タグ点（D17）の決定・drift 時の層別再設計（逆引き）
- **adaptive**: 触る system 層は subset でよいが、**読む対象と整合は常に global**（D31）

担わない（隣接モジュール）:

- spec.md / acceptance.yaml / manual-requirements.md の作成・署名 → オーサリング層
- spec.md@gitSha → IssueContract の resolve 実体 → M05
- 設計成果物の審査・**大域整合判定** → 設計審査役（本層から独立: ADR-0002 D20 + ADR-0004 D32）
- issue の投稿・状態機械・dispatch → M03 Coordinator
- 実装の内部 HOW（アルゴリズム・内部データ構造）→ M06 Generator。人間が固定したい場合のみ**非ゲートの
  実装メモ**として残す（D34）

## 2. 入力契約 (consumes)

- **ApprovedSpecRef**（オーサリング層）＋ `spec.md@gitSha`（AC behavior / scope / redLines）＋
  `acceptance.yaml@gitSha`（AC-ID → verification）＋ `manual-requirements.md@gitSha`（MR）。
- **system 層成果物（global・版固定で読む）**: `_system/domain-map.md` / `_system/data-model.md` /
  `_system/architecture.md`。本層は delta を作る前に**関連する system 層を読む**（大域整合の前提・D31/D32）。

前提条件:

- epic 状態が `contract-approved`（署名済み）。未署名 spec には着手しない。
- 全 AC が acceptance.yaml に自動採点 method を持つ。

## 3. 出力契約 (produces)

文書（人間が所有・編集）は**リッチ Markdown**、handoff（機械が受け渡す）は**構造化データ**（ADR-0004 D35）。
epic ディレクトリと system 層のレイアウト:

```text
specs/
  _system/                        # system 層（global・単一 SoT・追加のみ・全 epic が参照）
    domain-map.md                 # 要素 ID: DOM-NNN
    data-model.md                 # 要素 ID: DATA-NNN
    architecture.md               # 要素 ID: ARCH-NNN
  <epic>/
    spec.md / acceptance.yaml / manual-requirements.md   # オーサリング層
    design-delta.md               # 本層: 本 epic が system 層へ加えた拡張の記録
    slices/SLICE-<EPIC>-NNN.md     # 本層: コンポーネント設計（PR サイズ・1:1 で issue）
```

### 3.1 system 層成果物（global・リッチ Markdown・追加のみ）

各成果物は人間可読の Markdown 本文 ＋ **全体で一意・安定な要素 ID**。本層は既存を読み、必要なら新要素を
additive 追加する（本層が単独で「所有」するのではなく、全 epic が共有する単一物を拡張する）。

- **domain-map.md**（`DOM-NNN`）: ユビキタス言語・エンティティ/集約・関係・境界づけられたコンテキスト・
  ドメイン不変条件。
- **data-model.md**（`DATA-NNN`）: 論理データモデル → スキーマ（テーブル/列）・所有・移行戦略・永続化契約。
- **architecture.md**（`ARCH-NNN`）: モジュール境界・seam・共有基盤（**公開シェイプのみ**）・横断方針・
  アーキ不変条件。

不変条件:

- 要素 ID は **全体で一意・安定**。renumber・再利用しない。high-water-mark は当該成果物の既存最大番号
  スキャンで導出（本層はステートレス）。
- 進化は **additive**: 既存要素を書き換え・削除しない。変更が要るなら**新要素 ＋ 移行を additive 追加**し、
  旧要素は deprecated 印に留める（ID 安定・append-only 履歴を守る）。
- **contract altitude（D34）**: 各要素は記載テスト「これが無いと別の独立ユニットが非整合になるか？」で
  判定し Yes のみ書く。内部実装（アルゴリズム・内部データ構造）は書かない。共有基盤は公開シェイプ
  （signature・契約）まで・内部表現は実装に委ねる。

### 3.2 design-delta.md（epic 層・本 epic の拡張記録・リッチ Markdown）

本 epic が system 層に加えた拡張を1枚に集約する（監査・drift 逆引き・審査入力）。

```text
DesignDelta:
  epicId
  reads[]:                # 本 epic が前提として読んだ system 要素（版固定参照）
    - { artifact, elementId, gitSha }     # artifact ∈ {domain-map, data-model, architecture}
  extends[]:              # 本 epic が additive 追加した system 要素
    - artifact
      elementId:          新採番（DOM/DATA/ARCH-NNN）
      summary:            追加した概念/テーブル/決定の要約（本文は当該成果物に置く）
      rationale
      affectsAcIds[]:     この拡張が関わる AC-ID（drift 影響解析キー）
      humanReview:        bool            # 任意レビュータグ（D17）
```

### 3.3 DesignSlice（slice 層・コンポーネント設計・PR サイズ・リッチ Markdown）

1スライス = 1 issue = 1 PR。複数 AC をまたいでよい（β）。system 要素は**参照**し複製しない。

```text
DesignSlice:
  sliceId:            SLICE-<EPIC>-NNN     # 安定・不変。issue / IssueContract の join キー
  parentSliceId:      split 時の親（なければ null）
  title
  narrative:          { productGoal, userStory }   # M05 が IssueContract へ copy 投影する源泉
  coversAcIds[]:      このスライスが満たす AC-ID（複数可: β）
  coversMrIds[]:      関連 MR（human_review トリガ）
  dependsOnSystem[]:  参照する system 要素 ID（DOM/DATA/ARCH-NNN。決定を複製しない）
  dependsOnSlices[]:  先行スライス（依存順）
  componentDesign:    seam / 契約レベルのみ（contract altitude・内部構造は書かない）
  implementationNotes?: 任意・**非ゲート**の実装メモ。アルゴリズム/最適化を人間が固定したい時のみ（D34）
  testApproach:       acceptance.yaml の verification を実装でどう満たすか
  estimatedScope:     暫定 PR サイズ見積り（実サイズ超過は Generator が実装後に検知）
```

不変条件（被覆かつ排他・双方向）:

- 全スライスの `coversAcIds` の和集合 == spec.md@gitSha の AC-ID 全集合（被覆漏れも孤児も禁止）。
  スライス間で AC-ID は重複しない。
- AC は分割不可能な最小設計単位。PR サイズ超過 AC は**オーサリング層へ差し戻して AC を分割**する。
- `sliceId` は renumber・再利用しない。split 規約: spawn 前は新 sliceId 採番（自由）、spawn 後は親を
  retire し子に新 sliceId ＋ `parentSliceId`。high-water-mark は `slices/` の既存最大番号スキャンで導出。

### 3.4 IssueSpawnOrder（M21 → M03/M05・機械 handoff・構造化・全 Ref 版固定）

issue 投稿のための指示。**参照のみ**を持ち契約本体は埋め込まない。M05 resolve の入力になる。

```text
IssueSpawnOrder:
  epicId / sliceId:       SLICE-<EPIC>-NNN
  specRef:                { path, gitSha }      # spec.md（blob 版固定）
  verificationRef:        { path, gitSha }      # acceptance.yaml（blob 版固定）
  acceptanceCriteriaIds[] / manualRequirementIds[]
  sliceRef:               { path, gitSha }      # Tier slice（版固定）
  designDeltaRef:         { path, gitSha }      # epic デルタ（版固定）
  systemRefs[]:           { artifact, elementId, gitSha }   # 依存する system 要素（tech_stack 等の投影元）
  dependsOn[]:            先行 issue（dependsOnSlices 由来）
```

> M05 resolve はこれを入力に IssueContract を機械投影する。`tech_stack` の源泉は **architecture.md の
> system 要素**（旧 `tier1SpineRef` → `systemRefs` に置換）。M05 改訂時に追従させる（§9）。

## 4. 振る舞い / 処理フロー

epic 状態 `contract-approved → designing → design-reviewed → decomposed`（**状態ラベルの書き込みは M03**）。
本層は LLM 著者ゆえ状態を直接書かず、各ステップ完了を**シグナル**する。

1. **着手**: M03 が `designing` を書く。本層は ApprovedSpecRef ＋ **関連する system 層**を版固定で読む
   （大域整合の前提）。
2. **system 層デルタ**: 必要なドメイン/データ/アーキの拡張を **additive** に著す（新要素 ID を採番）。
   触らない層はスキップ（adaptive）。**ただし整合判断のために関連 system 層は読む**（D31）。
3. **design-delta.md**: `reads` / `extends`（affectsAcIds 付き）を記録する。
4. **スライス分解**: AC を PR サイズへ束ねる（被覆かつ排他・双方向）。`dependsOnSystem` で system 要素を参照。
5. **human_review タグ判定**: `humanReview` な拡張 / `tier: human_review` の MR を含むスライスに review トリガ。
6. **IssueSpawnOrder 出力** = 設計完成をシグナル。
7. **設計審査役の独立審査**（本層の外・ADR-0004 D32/D33）: M03 が dispatch。審査役が **層別観点（ドメイン/
   データ/アーキ = 全体に対して、スライス = epic 内）を1パスで**審査し DesignScorecard を産出。`pass` なら
   M03 が `design-reviewed → decomposed` を書き投稿、resolve は M05。`changes-requested` なら `designing` へ
   差し戻し、本層が逆引きで該当のみ再設計。

異常系・drift 連動（逆引き・該当のみ・全 tier 横断）:

- **AC drift**（オーサリング起因）: 変更/追加/削除 AC-ID を `affectsAcIds`（system 拡張）/ `coversAcIds`
  （スライス）で逆引きし、影響する拡張/スライスのみ再設計。
- **system 層 drift（global・新規）**: 変更/拡張された system 要素 ID を `dependsOnSystem` で逆引きし、
  影響スライスを**全 epic 横断**で再検証（大域整合・D32）。system 層は global ゆえ影響範囲も global。
- **foundation drift**: 共有基盤の遡及的切り出し。新要素を additive 追加し前向き逆引きで依存辺を張る
  （既存原則どおり・既存 ID を renumber せず）。
- **設計審査差し戻し**: finding の逆引きキー（要素 ID / sliceId / AC-ID）で該当のみ再設計。
- **サイズ超過**: Generator が実装後に検知 → 本層が split。

人間 override（任意）: `designing` の間、人間はスライス境界・system 拡張・design-delta を編集できる。

## 5. 機能要件 (FR)

`DSGN-FR-xxx`（ADR-0004 で三層化に改訂）。

- **DSGN-FR-001 着手前提**: `contract-approved` の epic にのみ着手し、ApprovedSpecRef と**関連 system 層**の
  gitSha で入力を pin する。
- **DSGN-FR-002 三層出力**: system 層デルタ（必要時）/ design-delta.md / DesignSlice 群を分けて産出する（D30）。
- **DSGN-FR-003 system 層 = global 単一 SoT・additive**: ドメイン/データ/アーキは全体で単一の生きた成果物。
  本層は読み、新要素を additive 追加するのみ。要素 ID は全体一意・安定・renumber/削除しない（D31）。
- **DSGN-FR-004 被覆かつ排他（双方向）**: 全スライス `coversAcIds` の和集合 == spec の AC-ID 全集合。
  スライス間で AC-ID 重複なし。AC は分割不可最小単位（超過は著述層へ差し戻し）。
- **DSGN-FR-005 PR サイズ分解（β）**: issue = PR サイズ。複数 AC をまたいで導出。`estimatedScope` は暫定見積り。
- **DSGN-FR-006 ID 安定 / split**: `sliceId` および system 要素 ID（DOM/DATA/ARCH）は不変。renumber・再利用禁止。
  high-water-mark スキャンで採番（本層ステートレス）。
- **DSGN-FR-007 参照渡し（全 Ref 版固定）**: IssueSpawnOrder / design-delta は spec・verification・slice・
  design-delta・**system 要素**への `{path/elementId, gitSha}` 参照のみを持ち、契約本体・設計本文を埋め込まない。
- **DSGN-FR-008 system 要素参照（非複製）**: スライスは system 要素を `dependsOnSystem` で参照し、内容を複製しない。
- **DSGN-FR-009 human_review タグ**: `humanReview` な拡張 / `tier: human_review` の MR を含むスライスに
  review トリガを立てる（D17）。
- **DSGN-FR-010 AC drift 影響局所化（双方向）**: 変更/追加/削除 AC-ID を逆引きし、該当する system 拡張 /
  スライスのみ再設計。無関係は不変。
- **DSGN-FR-011 system 層 drift 局所化（global）**: 変更/拡張された system 要素 ID を `dependsOnSystem` で
  **全 epic 横断**に逆引きし、影響スライスを再検証対象に挙げる（大域・D32）。
- **DSGN-FR-012 状態シグナル（書き込みは M03）**: 設計成果物の完成をシグナルするのみ。状態ラベル・resolve・
  投稿は行わない。
- **DSGN-FR-013 contract altitude（tier 別）＋ 実装メモ非ゲート（γ）**: 各 tier は決定 + モジュール間契約 /
  seam までに留め、クラス内部設計を書かない。内部 HOW は M06 に委ねる。人間が固定したい場合のみ
  `implementationNotes` に**非ゲートの実装メモ**として残す（D34）。
- **DSGN-FR-014 DRY の構造的防止（設計時の分担）**: アプリ全体 DRY は設計時に保証しない。本層は
  `_system` の共有基盤（公開シェイプ）＋ `dependsOnSlices` の依存順で**構造的に防止**。契約レベル重複は
  審査役、実装レベル重複は評価役が実コードに対して検出（ADR-0003 D27）。
- **DSGN-FR-015 foundation drift の additive 処理**: 抽出 work order を受けたら新共有基盤要素＋抽出/refactor
  スライスを**新採番で additive 追加**し、前向き逆引きで依存辺を張る。既存 ID を renumber しない。
- **DSGN-FR-016 adaptive（subset 拡張・整合は global）**: epic がデルタを出す system 層は subset でよい。
  しかし整合判断のため**関連 system 層は global に読む**。「触らない」と「整合を見ない」は別（D31）。
- **DSGN-FR-017 文書 / 機械の線引き**: 人間所有文書（system 層成果物・design-delta・slices）はリッチ
  Markdown、機械 handoff（IssueSpawnOrder）は構造化データ（D35）。

## 6. 非機能要件

- **入力決定性**: 同一 gitSha では同一の設計入力（spec ＋ system 層）を読む。出力は AI 著述ゆえ完全決定的では
  ないが、入力 pin が再現・監査の基盤。
- **人間可読性**: system 層成果物・design-delta・slices は Markdown で人間可読（D16/D35）。図・表・式・例を
  含めてよい（ドメイン/データ/アーキの説明はビジネス WHAT であり HOW ではない）。
- **contract altitude / 薄い実装層**: 出力は契約・seam・制約まで。内部設計は焼き込まず実装に委ねる。固定したい
  アルゴリズムは非ゲートの実装メモへ（D34）。
- **大域整合の著述責任**: 本層は system 層に対して**整合する**よう著す（読む対象は global）。整合の**審査**は
  設計審査役の所掌（D32）。
- **Git 追跡 / モデル独立性**: 成果物は repo 内・Git 履歴に乗せる。著者 AI の provider/model に依存しない出力。
- **可観測性 / 評価・改善トレース**: AC → 拡張/スライス → issue の対応が機械検証可能。設計起因失敗の層3 接続点の
  供給は設計審査役に移譲（ADR-0002 D25）。本層は逆引きキー（要素 ID / sliceId）を成果物に持たせ join を可能にする。

## 7. 不変条件・禁止事項 (red lines)

- spec.md / acceptance.yaml を**書き換えない**（SoT はオーサリング層）。WHAT を変えたくなったら層別差し戻し。
- system 層成果物を**破壊的に書き換えない**（additive のみ・既存 ID を renumber/削除しない）。
- IssueSpawnOrder / issue / design-delta に**契約本体・設計本文を埋め込まない**（参照のみ）。
- AC を取りこぼさない / 二重計上しない（被覆かつ排他・双方向）。1 AC をスライス側で分割しない。
- **クラス内部設計を contract altitude に書かない**（内部 HOW は M06。固定は非ゲートの実装メモへ）。
- アプリ全体 DRY を設計時に「保証」したと主張しない。
- `sliceId` / system 要素 ID を renumber・再利用しない。
- **状態ラベルを書き込まない**（書き込みは M03）。
- 全 Ref（system 要素含む）は版固定。可変参照で渡さない。
- 未署名（`contract-approved` 未満）の spec に着手しない。

## 8. 受け入れ条件 (testable)

- サンプル `contract-approved` spec.md から、必要な system 層拡張（domain/data/architecture のいずれか）と
  design-delta.md と複数の SLICE-*.md を生成でき、全 AC が**過不足なく**いずれかのスライスに割り付く。
- system 層を**触らない**小機能（例: 既存テーブルに nullable 列1本）で、design-delta が `reads` のみ／空の
  `extends` を持ち、スライスだけが生成される（adaptive を検証）。
- system 要素を1つ拡張 → design-delta の `extends` に新要素 ID が記録され、スライスが `dependsOnSystem` で
  参照し、内容を複製していないことを検証できる。
- spec.md の AC を1つ変更（drift）→ 影響する system 拡張 / スライスのみ再設計対象に挙がり、無関係は不変。
- system 要素を1つ変更（global drift）→ `dependsOnSystem` 逆引きで影響スライスが**epic を跨いで**挙がる。
- 各スライスから IssueSpawnOrder（spec/verification/slice/design-delta/system 参照 ＋ AC/MR 群）を生成でき、
  契約本体・設計本文が**埋め込まれていない**ことを検証できる。
- 設計文書（system/design-delta/slice）が contract altitude を超えず、クラス内部設計を本文に焼き込んでいない
  （固定したいアルゴリズムは `implementationNotes` に分離）ことを検証できる。
- 本層は spawn order を出力するのみで、状態ラベルの書き込み・resolve・投稿を行わない。

## 9. 既存実装とのギャップ / 移行方針

- [agents/issue-planner.md](../../../agents/issue-planner.md): 「設計 + 分解 + 契約生成」一体 → **分割**。
  設計判断（三層）と分解を本層へ、resolve（機械投影）を M05 へ。
- `src/planning/planner.ts`: seed YAML → contract 直接生成を**置換**。spec.md → 三層設計 → IssueSpawnOrder
  （参照）→ M05 resolve に組み替える。`Issue.contract` 埋め込み廃止と連動。
- **二層 → 三層の移行**: 旧 `ArchitectureSpine`（epic 共有 spine）を解体し、ドメイン/データ/アーキを
  `_system/` の global 成果物へ昇格。epic は spine を持たず `design-delta.md`（system へのデルタ）を持つ。
- **M05 への影響（cross-module・要追従）**: 旧 `tier1SpineRef` → `systemRefs[]`（architecture 等への版固定参照）。
  M05 は `tech_stack` を spine でなく `systemRefs` の architecture 要素から copy 投影する。M05 改訂時に反映
  （README §4.4 / 決定スタックで追跡）。
- 新規スキーマ: system 層成果物（DOM/DATA/ARCH 要素）/ `DesignDelta` / `DesignSlice` / `IssueSpawnOrder`。
  M01 共通契約モデルへ抽出する候補（垂直1本通過後）。

## 10. 未決事項 / 決定ログ

決定済（ADR-0001/0002/0003）: 二層化（spine+slice）・独立設計レビュ・contract altitude・DRY 分担・
foundation drift。これらのうち**二層 spine は ADR-0004 で三層へ解体**された。

本改訂で確定（ADR-0004 D30-D35・2026-06-18）:

- **設計を三層化**（system / epic / slice）。ドメイン/データ/アーキを epic 共有 spine から **global 単一 SoT**
  （`_system/`）へ昇格（D30/D31）。
- epic の設計 = system 層への **additive デルタ**（`design-delta.md`）＋ コンポーネント（D31）。
- **大域整合審査**は設計審査役の所掌（本層は global に整合するよう著す・D32）。
- 審査は **1パス＋層別セクション**、上流層は後で先行ゲート（D33）。
- **γ**: 強制は contract altitude のみ・固定は非ゲートの実装メモ（D34）。
- 文書 = リッチ Markdown / 機械 handoff = 構造化（D35）。

残 open:

- system 層成果物の住処の粒度（domain-map を境界コンテキスト単位で分割するか1枚か）。M18 連動・ADR-0004 §6。
- `design-delta.md` の最小スキーマの確定（拡張要素の記述粒度）。
- `estimatedScope` の判定基準（暫定見積り。実超過は Generator 検知）。
- system 要素 ID の採番接頭辞（global ゆえ epic prefix を持たない: DOM/DATA/ARCH-NNN）の最終確定。
- M05 `tier1SpineRef → systemRefs` 追従（cross-module）。
