# M22 Design Reviewer 仕様

- 正本参照: ADR-0002（[0002](../decisions/0002-independent-design-review.md) D20-D25）,
  ADR-0003（[0003](../decisions/0003-spec-altitude-and-dry.md) D26-D29）,
  **ADR-0004（[0004](../decisions/0004-layered-design-and-global-review.md) D30-D35・層別審査 / 大域整合 / γ）**,
  **ADR-0007（[0007](../decisions/0007-design-layer-agents-and-cadence-gradient.md) D44・著者4役でも審査は単一 / 派生図表は非ゲート）**,
  ADR-0001 D14/D16/D17, REQUIREMENTS.md §3/§16
- 参考実装: [agents/evaluator.md](../../../agents/evaluator.md)（独立評価者パターンの流用元）, `src/graders/index.ts`
- 仕様状態: 下書き（ADR-0004 で層別審査 + 大域整合に改訂・ADR-0007 で単一審査トポロジを確認）
- 最終更新: 2026-06-24

## 1. 目的とスコープ境界

設計立案役が著した三層の設計成果物（system 層拡張 / design-delta / DesignSlice / IssueSpawnOrder）を、
**issue spawn 前**に **設計立案役から独立**して審査し、`DesignScorecard` を産出する層。設計が AI 著者で
ある以上、自己評価でない独立審査を必須とする。

主務は **層別の整合審査**であり、特に **system 層（ドメイン/データ/アーキ）への拡張は全体に対する大域整合**で
見る（ADR-0004 D32）。局所品質の採点ではない。epic ライフサイクルの `designing → design-reviewed`（合格）/
`→ designing` 差し戻し（不合格）を担う。

担う:

- 設計成果物の **決定的検証**（被覆かつ排他・ID 安定・参照実在・DAG・名前衝突・additive・埋め込み禁止）
- **層別の整合審査**（ドメイン/データ/アーキ = 全体に対して、スライス = epic 内）= 大域 coherence
- `DesignScorecard`（blocking / non-blocking・finding は要素 ID / sliceId / AC-ID を参照）の産出
- 設計起因失敗を層3（`design_failure` taxonomy）へ携帯する観測点の供給

担わない（隣接モジュール）:

- 設計の著述・修正（再設計）→ 設計立案役（本層は finding を返すだけ・逆引きで修正は立案役）
- spec.md / acceptance.yaml / MR の作成・署名 → オーサリング層
- 状態ラベル書き込み・差し戻し dispatch・投稿 → M03（本層は完成をシグナルのみ）
- 実装成果（PR）の評価 → M07 Evaluator（入力・証拠・タイミングが異なる別モジュール）
- spec.md@gitSha → IssueContract の resolve → M05
- **実装レベル DRY**（再発明ロジック・コピペ）→ M07 が実コードに対して。本層は**契約レベル DRY**まで
- **実装メモ（implementationNotes）の正否審査**: アルゴリズム/最適化は **非ゲート**で審査しない（D34・γ）。
  本層は契約 altitude のみをゲートする

> **重複に対する立場（ADR-0003 D27/D29・ADR-0004 D34）**: 設計時に重複の不在を保証しない。契約レベル = 本層、
> 実装レベル（per-PR）= M07、cross-PR 残留 = M10/M21 の foundation-drift 事後抽出で回収。

## 2. 入力契約 (consumes)

すべて版固定（`{path/elementId, gitSha}`）。設計立案役が出力し設計完成をシグナルした成果物群 ＋ 根拠の WHAT ＋
**整合の基準となる system 層の現状（global）**:

- **system 層成果物（global）@gitSha**: `_system/domain-map.md`（DOM-NNN）/ `data-model.md`（DATA-NNN）/
  `architecture.md`（ARCH-NNN）。**拡張の大域整合を判定する基準**ゆえ全体を読む。
- **design-delta.md@gitSha**: 本 epic の `reads[]` / `extends[]`（affectsAcIds 付き）。
- **DesignSlice[]@gitSha**: sliceId / coversAcIds / coversMrIds / dependsOnSystem / dependsOnSlices /
  componentDesign / implementationNotes / testApproach。
- **IssueSpawnOrder[]**: spawn order 群（参照集合・版固定）。
- **spec.md / acceptance.yaml / manual-requirements.md@gitSha**: 設計↔spec の意味的整合の根拠（読むが書き換えない）。

前提条件:

- spec 状態が `designing` で、設計立案役が設計完成をシグナル済み。
- 入力はすべて gitSha pin（審査の決定性の基盤）。
- 審査者の AI コンテキストは**設計立案役と共有しない**（自己評価の排除）。

## 3. 出力契約 (produces)

### 3.1 層別の整合審査（整合性 tier の本体）

5軸の単一審査ではなく、**設計層ごとの観点**で審査する（ADR-0004 D30/D32）。スコープが層で異なる:

| 層 | 整合スコープ | 何を見るか | blocking 化の基準 |
| --- | --- | --- | --- |
| ドメイン | **global**（全体 or 境界コンテキスト） | 拡張した概念がドメインマップ全体と整合するか（既存概念の別名重複・境界侵犯・不変条件矛盾の有無） | 概念重複・境界侵犯・不変条件矛盾は blocking |
| データ | **global** | 拡張したスキーマがデータモデル全体・ドメインマップと整合するか（所有・正規化・移行後方互換・永続化契約） | 既存スキーマとの矛盾・後方互換破壊・ドメイン不整合は blocking |
| アーキ | **global** | 拡張した境界/seam/共有基盤が全体と整合するか（境界 coherence・seam 噛み合い・共有基盤の意味的重複） | 境界矛盾・seam 不一致・契約レベル重複は blocking |
| スライス | **epic 内** | 被覆を超えて componentDesign が依存 system 要素に反しないか / cross-slice 前提供給 / AC 意図充足 / redLine 不侵犯 | 参照背反・前提供給欠落・AC 意図取りこぼし・redLine 侵犯は blocking |

**整合性 tier の rubric は contract altitude で書く（層ごとチェックリストを作らない・D34/D29⑤）。** 全層に一様に適用する2要素を固定する:

- **証拠要件（finding の falsifiability）**: finding は違反の**具体物**（別名重複する概念の対 / 矛盾するスキーマ /
  背反する要素 ID / 満たされない AC 意図）を引用しなければ無効。
- **blocking 判定の単一手続き**: 実装を**待たずに**違反と確定でき、かつ**独立ユニット（他 epic / 他スライス /
  他 PR）を非整合にする**なら blocking。一部でも実装まで不可知なら non-blocking。

> **γ（D34）**: `implementationNotes`（アルゴリズム/最適化）は審査の**対象外・非ゲート**。本層は契約 altitude
> （層を跨ぐ約束）の整合のみをゲートする。実装メモの正否は M06/M07 の実コード側に委ね、設計ドキュメントから
> blocking として断定しない。

### 3.2 DesignScorecard（M22 産・機械成果物・構造化データ）

人間文書でなく**機械が受け渡す成果物**ゆえ構造化のまま（Markdown 化しない・D35）。`EvalScorecard` と同構造。

```text
DesignScorecard:
  epicId
  reviewedRefs:               # 審査対象の版固定参照（決定性・監査）
    systemRefs[]:    { artifact, elementId, gitSha }
    designDeltaRef:  { path, gitSha }
    sliceRefs[]:     { sliceId, path, gitSha }
    spawnOrderIds[]: SLICE-<EPIC>-NNN
    specRef:         { path, gitSha }
  graderTiers:
    deterministic:   pass | fail   # 層1: 被覆/排他・ID・参照・DAG・名前衝突・additive・埋め込み（§3.3）
    consistency:     pass | fail   # 層2: 層別整合（§3.1）
  findings[]:
    id
    severity:        blocking | non-blocking
    layer:           domain | data | architecture | slice | det
    refs[]:          DOM/DATA/ARCH-NNN / sliceId / AC-ID（逆引きキー）
    statement:       何が整合していないか（人間可読）
    evidence:        判定根拠（参照箇所・矛盾の対）
  verdict:           pass | changes-requested   # blocking 空 ⇔ pass
  failureClass:      design_failure サブ分類（層3 携帯用）。pass なら null
```

### 3.3 決定的 tier（層1・LLM 判断を要さない構造検証）

- **被覆かつ排他・双方向**: 全スライス `coversAcIds` の和集合 == spec.md@gitSha の AC-ID 全集合。重複なし。
- **ID 安定**: `sliceId` / system 要素 ID（DOM/DATA/ARCH）に renumber・再利用がない。
- **additive（system 層）**: design-delta の `extends` が**既存 system 要素を書き換え・削除していない**
  （新採番のみ・既存 ID 不変）。
- **参照実在**: `dependsOnSystem` の要素 ID が当該 system 成果物に存在 / `reads` `extends` の参照が版固定で
  解決可能 / `coversMrIds` の MR-ID が実在 / IssueSpawnOrder の全 Ref が版固定。
- **依存 DAG 非循環**: `dependsOnSlices` が DAG を成す（循環は blocking）。
- **共有基盤の名前非衝突**: `_system` の共有基盤・公開シェイプ識別子に機械的重複（同一キー二重定義）がない。
- **埋め込み禁止**: IssueSpawnOrder / design-delta に契約本体・設計本文が埋め込まれていない（参照のみ）。

決定的 tier の fail は当然 blocking（構造破綻は実装前に確定）。

## 4. 振る舞い / 処理フロー

spec 状態 `designing → design-reviewed → decomposed`。状態書き込みは M03。本層は審査完了を**シグナル**のみ。

1. **着手**: 設計立案役がシグナル → M03 が M22 を dispatch。入力 §2 を gitSha で pin して読む
   （**system 層は全体**を読む = 大域整合の基準）。
2. **決定的 tier**: §3.3 を機械検査。fail は blocking finding。
3. **整合性 tier（1パス・層別セクション）**: §3.1 の4層を **1回で**審査し、層別の finding を severity 付きで
   記録（ADR-0004 D33・最薄ループ）。各 finding に逆引きキー（要素 ID / sliceId / AC-ID）を必ず付す。
4. **DesignScorecard 出力**: blocking 空なら `verdict: pass`、非空なら `changes-requested` = 審査完了シグナル。
5. **分岐（M03 が実施）**:
   - `pass` → `design-reviewed → decomposed`、投稿、resolve は M05。
   - `changes-requested` かつ blocking が **humanReview 領域**に触れる → human escalate。
   - `changes-requested`（上記以外）→ `designing` 差し戻し → 立案役が finding の逆引きキーで**該当の system
     拡張 / スライスのみ**再設計 → 再シグナルで再 dispatch（設計内側ループ）。試行上限超過で human escalate。

異常系:

- **入力 drift（再設計中に spec / system 層が変わる）**: 版が食い違えば審査前提が崩れる → blocking
  （`data`/`domain`/`slice` 該当層）として差し戻し、版整合を要求。
- **non-blocking のみ**: spawn は止めない。層3（design_failure）へ携帯。
- **無限ループ防止**: 設計内側ループの試行上限・escalate は M08 Repair Router と対称化（具体は M03/M08 確定時）。

## 5. 機能要件 (FR)

`DREV-FR-xxx`（ADR-0004 で層別審査に改訂）。

- **DREV-FR-001 独立性**: 設計立案役と AI コンテキストを共有しない（自己評価の排除）。
- **DREV-FR-002 spawn 前審査**: issue spawn の前に審査。`decomposed` 遷移は `verdict: pass` を条件とする。
- **DREV-FR-003 層別・大域整合が主務**: ドメイン/データ/アーキの拡張は**全体に対して**整合を見る（D32）。
  スライスは epic 内。局所品質は blocking にしない（最大 non-blocking）。
- **DREV-FR-004 決定的 tier**: §3.3（被覆/排他・ID・additive・参照・DAG・名前衝突・埋め込み）を機械検査し fail を
  blocking 化。
- **DREV-FR-005 blocking 基準 = 整合性違反**: 実装を待たず確定できる整合性違反に限定（概念重複・スキーマ矛盾・
  参照背反・cross-slice 不一致・AC 意図取りこぼし・redLine 侵犯・additive 破り・drift）。一部が実装まで不可知な
  局所品質は non-blocking。
- **DREV-FR-006 DesignScorecard**: §3.2 のスキーマで出力。全 finding に逆引きキーを付す。構造化データのまま
  （機械成果物・D35）。`EvalScorecard` と同構造を保つ。
- **DREV-FR-007 状態シグナル（書き込みは M03）**: 審査完了をシグナルのみ。ラベル書き込み・dispatch・投稿しない。
- **DREV-FR-008 再設計の局所化キー供給**: finding の逆引きキーで立案役が該当箇所のみ再設計できる。
- **DREV-FR-009 SoT 不可侵**: spec.md / acceptance.yaml / 設計成果物を書き換えない。findings のみ産する。
- **DREV-FR-010 層3 接続**: 設計起因の知見を `design_failure` サブ分類で M10 Curator / M12 Analyst へ送る
  観測点を供給。
- **DREV-FR-011 契約レベル DRY 審査**: 設計上で確定できる重複（責務重複スライス・冗長境界・重複する共有基盤）を
  審査。実装レベル重複は M07 所掌として本層では断定しない。
- **DREV-FR-012 foundation drift 抽出の過結合審査**: 遡及導入した共有基盤が過結合・誤った抽象でないかを審査
  （束ねた consumer が同じ理由で変わるか・公開シェイプが安定か）。
- **DREV-FR-013 整合性 rubric の高度（層別チェックリスト禁止）**: 層ごとのしきい表を持たず、全層共通の
  証拠要件 ＋ 単一 blocking 判定手続きで採点（D34/D29⑤）。
- **DREV-FR-014 human escalation 発火条件**: blocking ∩ humanReview 領域 → 即 escalate。その他 blocking は
  立案役の内側ループへ自動差し戻し、試行上限超過で escalate。
- **DREV-FR-015 実装メモ非ゲート（γ）**: `implementationNotes`（アルゴリズム/最適化）を審査せず blocking に
  しない。本層は契約 altitude のみをゲートする（D34）。

## 6. 非機能要件

- **審査決定性**: 同一 gitSha で同一入力を読む。整合性判断は LLM 著述ゆえ完全決定的ではないが、入力 pin と
  決定的 tier で再現・監査の基盤を確保。
- **独立性 / モデル独立**: 著者（立案役）と審査者（本層）の provider/model・コンテキストを分離。
- **証拠性**: 各 finding は `evidence` を持ち、blocking 判定が trust でなく証拠で裏付く。
- **可観測性 / 評価・改善トレース（層3）**: 設計起因失敗を `design_failure`（誤った分割 / 誤ったアーキ・データ・
  ドメイン決定 / 設計↔spec 不整合）として M10/M12 へ送る経路の存在を保証。要素 ID / sliceId と後段 scorecard の
  join で「どの設計判断が後段失敗に関与したか」を辿れる。

## 7. 不変条件・禁止事項 (red lines)

- spec.md / acceptance.yaml / 設計成果物を書き換えない（SoT 不可侵・修正は立案役）。
- 状態ラベルを書き込まない / 差し戻し dispatch・投稿をしない（M03 の所掌）。
- 設計を自分で著述・修正しない（findings を返すのみ）。
- 局所品質を blocking にしない（blocking は整合性違反に限定）。
- **実装メモ（implementationNotes）を審査・blocking にしない**（非ゲート・γ）。
- 設計立案役と AI コンテキストを共有しない。
- 審査対象は全て版固定参照で読む。pass を証拠なしに出さない。
- 実装レベル DRY 違反を設計ドキュメントだけから blocking として断定しない（M07 の実コード評価に委ねる）。

## 8. 受け入れ条件 (testable)

- 三層の設計成果物（system 拡張 + design-delta + slices + spawn order）を入力に DesignScorecard を生成でき、
  決定的 tier と層別整合の判定が出る。
- **大域整合の検出**: 既存ドメイン概念と**別名で重複**する概念を追加した design-delta で、ドメイン層の finding が
  blocking として立つ（全体を読まないと捕まらないことの検証）。既存スキーマと矛盾するデータ拡張も同様。
- **整合性違反の検出**: 参照した system 要素に反する componentDesign / 宣言依存が実依存と乖離 / cross-slice の
  前提供給欠落で、当該 finding が blocking。`dependsOnSlices` の循環は決定的 tier が blocking。
- **additive 破りの検出**: design-delta が既存 system 要素 ID を renumber/書き換えた場合、決定的 tier が blocking。
- **局所品質は止めない**: componentDesign の文章が粗いだけは non-blocking で `verdict: pass`。
- **実装メモは審査しない**: `implementationNotes` のアルゴリズムが非効率でも blocking にならない（γ）。
- **逆引きキー**: 全 finding が要素 ID / sliceId / AC-ID を持ち、立案役が該当箇所のみ再設計できる。
- **状態を書かない / 独立性**: スコアカードを出すのみ。M21 のコンテキストに依存せず版固定参照だけから再現できる。

## 9. 既存実装とのギャップ / 移行方針

- [agents/evaluator.md](../../../agents/evaluator.md): 独立評価者パターン（独立・scorecard・3段階 grader）を**流用**。
  入力を PR → 三層設計成果物に、証拠を test 実行 → 大域整合判断 + 構造検証に差し替える。
- `src/graders/index.ts`: hard gates → composite score の枠組みを流用候補。決定的 tier = hard gate、整合性 tier =
  LLM grader。
- **単一審査 → 層別審査の移行**: 旧 5軸（Tier1 内部 / Tier1↔Tier2 / cross-slice / design↔spec / whole-purpose）を、
  三層 + global スコープの**層別観点**へ再編（§3.1）。Tier1↔Tier2 の背反審査は「スライスが依存 system 要素に
  反するか」に、whole-purpose の契約 DRY はアーキ層へ移る。
- 新規スキーマ: `DesignScorecard`（layer フィールド・systemRefs を持つ）。`EvalScorecard` と構造を揃え M01 抽出候補。

## 10. 未決事項 / 決定ログ

決定済（ADR-0002）: D20 新設 / D21 整合性主務 / D22 blocking=整合性違反 / D23 状態挿入 / D24 逆引き再設計 /
D25 層1=決定的・層3=design_failure。

本改訂で確定（ADR-0004 D30-D35・2026-06-18）:

- **5軸の単一審査 → 三層 + global の層別審査**（D30/D32）。ドメイン/データ/アーキの拡張は**全体に対する大域
  整合**で見る。スライスは epic 内。
- **審査は1パス + 層別セクション**、上流層は後で先行ゲート（D33）。
- **γ**: `implementationNotes` は非ゲート・審査対象外（D34）。本層は契約 altitude のみをゲートする。
- **DesignScorecard は構造化データのまま**（機械成果物・D35）。`layer` / `systemRefs` を追加。
- 決定的 tier に **additive 破り検査**（system 要素の renumber/書き換え禁止）を追加。

本改訂で確定（ADR-0007 D44・2026-06-24）:

- **著者を4役（基本/DB/詳細/図表）に割っても審査は本層単一**。4 役の成果物を 1 人が層別セクションで審査し、
  著者≠審査者の独立性を保つ（D44）。役ごとに審査を付けない（多段ゲート回避・D33）。
- **派生図表は審査対象外・非ゲート**（`implementationNotes` と同じ扱い・γ）。図は data-model/architecture/
  domain-map/slice の SoT から派生するため、審査は source 側の整合で足りる（ADR-0007 D42）。

残 open:

- 設計内側ループの試行上限・escalate（M08 と対称化）。M03/M08 確定時。
- 大域整合審査の**決定的部分**（名前衝突・参照整合・重複エンティティ検出）と**判断部分**（意味的重複・概念の
  別名重複）の振り分け。ADR-0004 §6。
- `design_failure` サブ分類の確定と正本 §16 taxonomy への追記（別コミット）。
- `DesignScorecard` / `EvalScorecard` の M01 共通化。
- drift 再審査時の差分審査（変更要素のみ再審査するか全体か）の効率最適化。
