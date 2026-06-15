# M22 Design Reviewer 仕様

- 正本参照: ADR-0002（[decisions/0002](../decisions/0002-independent-design-review.md) D20-D25）,
  ADR-0003（[decisions/0003](../decisions/0003-spec-altitude-and-dry.md) D26-D28・contract altitude / DRY 分担）,
  ADR-0001 D14/D16/D17（設計二層・可読性・human_review）, REQUIREMENTS.md §3（評価独立性）, §16（failure_taxonomy）
- 参考実装: [agents/evaluator.md](../../../agents/evaluator.md)（**独立評価者パターンの流用元**。入力が PR→設計に変わる）,
  `src/graders/index.ts`（3段階 grader の流用候補）
- 仕様状態: 下書き
- 最終更新: 2026-06-15

## 1. 目的とスコープ境界

M21 Design Planner が著した設計成果物（ArchitectureSpine / DesignSlice / IssueSpawnOrder）を、
**issue spawn 前**に **M21 から独立**して審査し、`DesignScorecard` を産出する層（ADR-0002 D20）。
人間は最上位要求（spec.md / AC）のみを定義・署名し、その下の設計は AI 著者となる（ADR-0001 D13/D16）。
**設計が AI 著者である以上、自己評価でない独立審査を必須**とする——これが本層の存在理由。

主務は **全体整合性（大域 coherence）の審査**であり、スライス1枚ごとの局所品質採点ではない（D21）。
epic ライフサイクルの `designing → design-reviewed`（合格時）/ `→ designing` 差し戻し（不合格時）を担う。

担う:

- 設計成果物の **決定的検証**（被覆かつ排他・ID 安定・参照実在・埋め込み禁止）= grader 決定的 tier
- 設計成果物の **整合性審査**（大域 coherence）= grader LLM/human tier。下記5軸（§3.1）
- `DesignScorecard`（blocking / non-blocking・finding は sliceId/ARCH-ID/AC-ID を参照）の産出
- 設計起因失敗を層3（`design_failure` taxonomy）へ携帯する観測点の供給

担わない（隣接モジュール）:

- 設計の **著述・修正**（再設計） → M21 Design Planner（本層は finding を返すだけ。修正は M21 が逆引きで行う: D24）
- spec.md / acceptance.yaml / MR の作成と署名 → M20 オーサリング層
- 状態ラベルの書き込み・差し戻し dispatch・issue 投稿 → M03 Coordinator（本層は完成をシグナルするのみ: D23）
- 実装成果（PR）の評価 → M07 Evaluator（入力・証拠・タイミングが異なる別モジュール: ADR-0002 §5）
- spec.md@gitSha → IssueContract の resolve → M05
- **実装レベル DRY**（再発明されたロジック・コピペ）の検出 → M07 Evaluator が**実コードに対して**行う。本層は
  **契約レベル DRY**（責務重複・冗長なモジュール境界）まで（設計ドキュメントしか見ないため。ADR-0003 D27）

> スコープ境界の要点（D21）: 本層は **設計が全体として整合するか**を判定する。局所品質（componentDesign の
> 文章・命名・分割趣味）は **最大でも non-blocking**。被覆/排他は集合演算で必要だが「良い設計」には不十分で、
> 最悪の分割（全 AC を1スライス）でも被覆は通る——だから整合性 tier が要る。

## 2. 入力契約 (consumes)

すべて版固定（`{path, gitSha}`）。M21 が出力し設計完成をシグナルした成果物群 + その根拠となる WHAT:

- **ArchitectureSpine@gitSha**（M21 §3.1）: `decisions[]`(ARCH-ID / decision / rationale / affectsAcIds / humanReview),
  `moduleBoundaries[]`, `sharedFoundations[]`, `crossCuttingPolicies[]`, `invariants[]`。
- **DesignSlice[]@gitSha**（M21 §3.2）: `sliceId` / `coversAcIds` / `coversMrIds` / `dependsOnSpine` /
  `dependsOnSlices` / `componentDesign` / `testApproach` / `estimatedScope`。
- **IssueSpawnOrder[]**（M21 §3.3）: spawn order 群（参照集合・版固定）。分解の最終形。
- **spec.md@gitSha / acceptance.yaml@gitSha / manual-requirements.md@gitSha**（M20）: 設計↔spec の意味的整合
  （AC 意図の充足・redLines 不侵犯）と verification 整合を判定する根拠。**読むが書き換えない**。

前提条件:

- epic 状態が `designing` で、M21 が設計完成をシグナル済みであること。
- 入力はすべて gitSha pin（審査の決定性の基盤。同一 gitSha なら同一入力を読む）。
- 審査者の AI コンテキストは **M21 と共有しない**（自己評価の排除。M16 モデル独立に準拠）。

## 3. 出力契約 (produces)

### 3.1 審査軸（5つ・整合性 tier の本体）

| # | 軸 | 何を見るか | blocking 化の基準 |
| --- | --- | --- | --- |
| ① | Tier1 内部整合 | `decisions[]` が相互矛盾しない / `invariants[]` が自己無矛盾 | 矛盾・自己撞着があれば blocking |
| ② | Tier1↔Tier2 整合 | スライスが `dependsOnSpine` で参照した ARCH 決定に**反する設計**をしていないか | 参照先決定への背反は blocking |
| ③ | cross-slice 整合 | あるスライスが前提するものを別スライスが供給するか / interface・契約が噛み合うか / `dependsOnSlices` が健全な DAG か（循環なし・実依存と一致） | 前提供給の欠落・interface 不一致・循環依存は blocking |
| ④ | 設計↔spec 意味的整合 | 集合被覆（決定的 tier）を**超えて**、componentDesign が `coversAcIds` の AC **意図**を満たしうるか / redLines を侵さないか / testApproach が acceptance.yaml の verification を exercise するか | AC 意図の取りこぼし・redLine 侵犯は blocking |
| ⑤ | 全体目的整合 | 分割が epic ゴールへ向かう coherent な物語か（恣意的・場当たり分割でないか）/ **契約レベル DRY**: 責務が重なるスライス・冗長なモジュール境界・重複する `sharedFoundations` がないか | 重大な非coherence・契約レベル重複は blocking、軽微は non-blocking |

### 3.2 DesignScorecard（M22 産・M03/M10 への出力）

`EvalScorecard` と同構造（blocking/non-blocking 分離）。M01 共通化候補（ADR-0002 §5）。

```text
DesignScorecard:
  epicId
  reviewedRefs:                # 審査対象の版固定参照（決定性・監査）
    spineRef:        { path, gitSha }
    sliceRefs[]:     { sliceId, path, gitSha }
    spawnOrderIds[]: SLICE-<EPIC>-NNN
    specRef:         { path, gitSha }
  graderTiers:                 # どの tier で何を見たか（証拠トレース）
    deterministic:   pass | fail   # 層1: 被覆/排他・ID・参照・埋め込み（§3.3）
    consistency:     pass | fail   # 層2: 整合性5軸（§3.1）
  findings[]:
    id
    severity:        blocking | non-blocking
    axis:            det | t1-internal | t1-t2 | cross-slice | design-spec | whole-purpose
    refs[]:          ARCH-ID / sliceId / AC-ID（M21 の逆引きキー: D24）
    statement:       何が整合していないか（人間可読）
    evidence:        判定根拠（参照箇所・矛盾の対）
  verdict:           pass | changes-requested   # blocking 空 ⇔ pass
  failureClass:      design_failure サブ分類（層3 携帯用・§6）。pass なら null
```

### 3.3 決定的 tier（層1・grader 決定的段）

LLM 判断を要さない構造検証。M21 の不変条件（design-planner.md §3.2/§7）を**機械的に再検査**する:

- **被覆かつ排他・双方向**: 全スライス `coversAcIds` の和集合 == spec.md@gitSha の AC-ID 全集合。重複なし。
- **ID 安定**: `ARCH-ID` / `sliceId` に renumber・再利用がない（spawn 後の split は `parentSliceId` 追跡）。
- **参照実在**: 各 `dependsOnSpine` の ARCH-ID が spine に存在 / `coversMrIds` の MR-ID が MR に存在 /
  IssueSpawnOrder の全 Ref が版固定（`{path, gitSha}`）で解決可能。
- **埋め込み禁止**: IssueSpawnOrder に契約本体・設計本文が埋め込まれていない（参照のみ: D8）。

決定的 tier の fail は当然 blocking（構造破綻は実装前に確定）。

## 4. 振る舞い / 処理フロー

epic 状態 `designing → design-reviewed → decomposed`（ADR-0002 D23）。状態書き込みは M03。M22 は審査完了を
**シグナル**するのみ（B2 踏襲）。

1. **着手**: M21 が設計完成をシグナル → M03 が M22 を dispatch。M22 は入力 §2 を gitSha で pin して読む。
2. **決定的 tier**: §3.3 を機械検査。fail は blocking finding として記録。
3. **整合性 tier**: §3.1 の5軸を審査。違反を severity 付き finding（blocking/non-blocking）で記録。
   各 finding に逆引きキー（ARCH-ID/sliceId/AC-ID）を必ず付す（D24 の再設計局所化のため）。
4. **DesignScorecard 出力**: blocking 空なら `verdict: pass`、非空なら `changes-requested`。
   = **審査完了をシグナル**。これを受けて M03 が状態を書く。
5. **分岐（M03 が実施）**:
   - `pass` → `design-reviewed → decomposed`、issue 投稿、resolve は M05 へ。
   - `changes-requested` → `designing` へ差し戻し → M21 が finding の逆引きキーで**該当 sliceId/ARCH-ID
     のみ**再設計（DSGN-FR-010/011 と同じ機構: D24）→ 再シグナルで M22 を再 dispatch（設計内側ループ）。

異常系:

- **入力 drift（M21 が再設計中に spec が変わる）**: spec.md@gitSha と spine/slice の gitSha が食い違う場合、
  審査の前提が崩れる → blocking（`design-spec` 軸）として差し戻し、M21 へ版整合を要求。
- **non-blocking のみ**: spawn は止めない。non-blocking findings は DesignScorecard に残し、層3
  （design_failure taxonomy）へ携帯（§6・C1）。
- **無限ループ防止**: 設計内側ループの試行上限・escalate は実装側 M08 Repair Router と対称化する想定
  （上限超過で human_review へ escalate）。**具体は M03/M08 確定時**（§10 open）。

## 5. 機能要件 (FR)

新規採番 `DREV-FR-xxx`。

- **DREV-FR-001 独立性**: M22 は M21 の設計成果物を審査し、**M21 と AI コンテキストを共有しない**
  （自己評価の排除。M07 が M06 から独立するのと同じ原則）。
- **DREV-FR-002 spawn 前審査**: issue spawn の**前**に審査する（shift-left）。decomposed への遷移は
  `verdict: pass` を条件とする。
- **DREV-FR-003 整合性主務**: 主務は全体整合性（§3.1 の5軸）。局所品質は **blocking にしない**（最大 non-blocking: D21）。
- **DREV-FR-004 決定的 tier**: §3.3（被覆/排他・ID・参照・埋め込み）を機械検査し、fail を blocking 化（D25）。
- **DREV-FR-005 blocking 基準 = 整合性違反**: blocking は「実装を待たず確定判定できる整合性違反」に限定する
  （相互矛盾・invariant 違反・参照背反・cross-slice 不一致・AC 意図取りこぼし・redLine 侵犯・spec drift）。
  「一部が実装まで不可知」な局所品質は non-blocking（false-block 回避: D22）。
- **DREV-FR-006 DesignScorecard**: §3.2 のスキーマで出力。全 finding に逆引きキー（ARCH-ID/sliceId/AC-ID）を付す。
  `EvalScorecard` と同構造を保つ（M01 共通化布石）。
- **DREV-FR-007 状態シグナル（書き込みは M03）**: 審査完了をシグナルするのみ。`design-reviewed`/`designing`
  差し戻しの**ラベル書き込み・dispatch・投稿はしない**（状態は M03: B2）。
- **DREV-FR-008 再設計の局所化キー供給**: finding の逆引きキーにより、M21 が**該当箇所のみ**再設計できる
  （全体再設計を強制しない: D24）。
- **DREV-FR-009 SoT 不可侵**: spec.md / acceptance.yaml / 設計成果物を**書き換えない**。審査結果（findings）
  のみを産する。
- **DREV-FR-010 層3 接続**: pass/fail に関わらず、設計起因の知見を `design_failure` サブ分類で
  M10 Curator / M12 Analyst へ送る観測点を供給（§6）。
- **DREV-FR-011 契約レベル DRY 審査**: M22 は設計ドキュメント上で確定できる重複（責務が重なるスライス・
  冗長なモジュール境界・重複する `sharedFoundations`）を全体目的整合（⑤）の一部として審査する。
  実装レベルの重複（再発明されたロジック・コピペ）は M07 の所掌として扱い、本層では断定しない（ADR-0003 D27）。
- **DREV-FR-012 foundation drift 抽出の過結合審査（ADR-0003 D29）**: M21 が遡及導入した `sharedFoundations`
  （新 ARCH + 抽出/refactor スライス）を審査する際、**過結合・誤った抽象（wrong abstraction）でないか**を
  ⑤ の一部として見る: 束ねた consumer が**同じ理由で変わる**か（形状だけの偶然の重複を結合していないか）、
  基盤の公開シェイプが安定か。抽出が結合コスト > 重複コストに見える場合は blocking。検出（事実）は M07/監査の
  所掌で、本層は**抽出という設計判断の妥当性**を審査する（判断は M10/M21、審査は M22）。

## 6. 非機能要件

- **審査決定性**: 同一 gitSha では同一入力を読む。整合性判断は LLM 著述ゆえ完全決定的ではないが、入力 pin と
  決定的 tier の機械検査で再現・監査の基盤を確保する（M07 の grader 思想と同じ）。
- **独立性 / モデル独立**: 著者 AI（M21）と審査 AI（M22）の provider/model・コンテキストを分離（M16 準拠）。
  自己評価を構造的に排除する。
- **証拠性**: 各 finding は `evidence`（参照箇所・矛盾の対）を持ち、blocking 判定が trust でなく証拠で裏付く
  （北極星「証拠で裏付いた判定の割合 ↑ / false-pass 率 ↓」）。
- **可観測性 / 評価・改善トレース（層3）**: design-planner.md §6 C1 を本層が引き取る。設計起因失敗を
  `design_failure`（誤った分割 / 誤ったアーキ決定 / 設計↔spec 不整合 等のサブ分類）として M10/M12 へ送る経路の
  **存在**を保証する（taxonomy の正本追記は ADR-0002 §4 の通り別コミット）。sliceId/ARCH-ID と後段 scorecard の
  join により「どの設計判断が後段失敗に関与したか」を辿れる。

## 7. 不変条件・禁止事項 (red lines)

- spec.md / acceptance.yaml / 設計成果物を**書き換えない**（SoT 不可侵・修正は M21）。
- **状態ラベルを書き込まない / 差し戻し dispatch・issue 投稿をしない**（M03 の所掌・B2）。
- **設計を自分で著述・修正しない**（findings を返すのみ。再設計は M21）。
- 局所品質を **blocking にしない**（blocking は整合性違反に限定: D21/D22）。
- M21 と **AI コンテキストを共有しない**（自己評価の排除: DREV-FR-001）。
- 審査対象は全て**版固定参照**で読む（可変参照で審査しない）。
- pass を **証拠なしに出さない**（blocking 空の根拠＝決定的 tier pass + 整合性5軸の証拠）。
- 実装レベルの DRY 違反を、設計ドキュメントだけから blocking として断定しない（M07 の実コード評価に委ねる）。

## 8. 受け入れ条件 (testable)

- M21 が産出した spine + slices + spawn order（例: octolink 相当）を入力に `DesignScorecard` を生成でき、
  決定的 tier（被覆/排他・ID・参照・埋め込み）と整合性5軸の判定が出る。
- **整合性違反の検出**: わざと矛盾を仕込んだ設計（例: スライス A が前提する出力をどのスライスも供給しない /
  参照した ARCH 決定に反する componentDesign / `dependsOnSlices` に循環）で、当該 finding が **blocking** として
  立ち、`verdict: changes-requested` になる。
- **局所品質は止めない**: componentDesign の文章が粗いだけの設計は **non-blocking** に留まり `verdict: pass`。
- **被覆は通るが非coherent**: 全 AC を1スライスに詰めた「被覆/排他は通るが分割が破綻」した設計で、決定的 tier は
  pass でも整合性 tier（⑤）が blocking を立てる（被覆検査だけでは捕まらないことの検証）。
- **契約レベル DRY**: 複数スライスが同じ責務や共有基盤を別々に所有すると主張する設計で、責務重複・冗長境界・
  `sharedFoundations` 重複が finding として出る。実装レベルの重複は M07 所掌として扱われる。
- **逆引きキー**: 全 finding が ARCH-ID/sliceId/AC-ID を持ち、M21 が該当箇所のみ再設計できる。
- **状態を書かない**: M22 は DesignScorecard を出すのみで、`design-reviewed`/`designing` 差し戻しの書き込み・
  dispatch・投稿を行わない（B2）。
- **独立性**: 審査が M21 のコンテキストに依存せず、入力（版固定参照）だけから再現できる。

## 9. 既存実装とのギャップ / 移行方針

- [agents/evaluator.md](../../../agents/evaluator.md): 独立評価者パターン（独立・scorecard・3段階 grader）を
  **流用**。入力を PR/GeneratorHandoff → 設計成果物に、証拠を test 実行 → 整合性判断＋構造検証に差し替える。
- `src/graders/index.ts`: hard gates → composite score の枠組みを**流用候補**。決定的 tier = hard gate、
  整合性 tier = LLM grader にマップ。
- 新規スキーマ: `DesignScorecard`（本層産）。`EvalScorecard` と blocking/non-blocking 構造を揃え、M01 共通契約
  モデルへ抽出する候補（垂直1本通過後）。
- 現行 `src/` に設計審査の経路は無い（新規）。M21 と一体で「設計→審査→（差し戻し）」の内側ループを新設する。

## 10. 未決事項 / 決定ログ

決定済（ADR-0002）: D20 M22 新設 / D21 整合性主務・5軸 / D22 blocking=整合性違反・局所品質 non-blocking /
D23 状態挿入 `designing→design-reviewed→decomposed`・書き込みは M03 / D24 再設計は M21 逆引き再利用 /
D25 層1=決定的 tier 吸収・層3=design_failure。

残 open:

- 整合性 tier の LLM grader 判定基準の具体化（5軸ごとの rubric）と human escalation 発火条件（humanReview タグ /
  blocking severity のしきい）。M22 確定時。
- 設計内側ループの試行上限・escalate 方針（実装側 M08 Repair Router と対称化するか）。M03/M08 確定時。
- `design_failure` サブ分類の確定と正本 §16 taxonomy への追記（ADR-0002 §4・別コミット）。
- `DesignScorecard` / `EvalScorecard` の M01 共通化（blocking/non-blocking envelope・grader 3段階 tier・逆引きキー規約）。
- M22 の audit 単位（spine 全体 + slices をまとめて1審査か、変更分のみの差分審査か）。drift 再審査の効率と関連。
