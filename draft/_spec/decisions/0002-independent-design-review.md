# 決定記録 0002: 独立設計レビュ・設計評価ループ

- 状態: 確定
- 最終更新: 2026-06-15
- 影響モジュール: M21 Design Planner / **M22 Design Reviewer（新規）** / M03 Development Coordinator /
  M07 Evaluator（独立性原則の踏襲元）/ M10 Eval Curator（層3 受け皿）/ M01 共通契約モデル（DesignScorecard 抽出候補）
- 正本差分: REQUIREMENTS.md §16 `failure_taxonomy` に `design_failure` を追加（**本 ADR では接続点のみ規定。
  正本追記は別途**。§4 参照）

> ⚠️ **ADR-0008 で更新**: 本 ADR の「epic 状態機械」（D23: `designing → design-reviewed → decomposed`）の
> "epic" は、ADR-0008（D50-D54）で **spec** へ改名（署名/設計の状態は spec 単位の「spec 状態オブジェクト」が
> 持つ）。状態遷移そのものは不変。原文は決定記録として保持する。

## 1. 背景

ADR-0001 で WHAT（オーサリング M20・人間署名）と HOW（設計 M21・実装 M06 以降・AI）を分離した。
その結果、**人間の判断点は最上位要求（spec.md / AC）の定義と承認に限られ、その下の詳細設計
（Tier1 アーキ・スパイン / Tier2 設計スライス）は AI が著者**となる（D13/D14/D16）。

ここに非対称があった。**実装（M06 Generator の成果）には独立した評価者（M07 Evaluator）が
証拠付き scorecard で受理前に合否を出す**のに対し、**設計（M21 の成果）には独立した評価点が無い**。
設計に対して存在したのは (a) D17 の任意の human_review ゲート（人間・任意・ゲートであって評価者でない）と
(b) design-planner.md §6 C1 の事後トレース接続点（実装が失敗してから設計を遡る）だけだった。

北極星は「**評価可能** = 開発プロセスと成果を証拠で評価できる」を三能力の一つに数える。設計は
プロセスの一部でありながら証拠ベースの評価点を欠いていた。**人間が WHAT のみを定義し設計を AI に
委ねる以上、設計の独立審査は必須**——これを本 ADR で確定する。

## 2. 確定した決定（理由つき）

| # | 決定 | 理由 |
| --- | --- | --- |
| D20 | **M22 Design Reviewer を新設**（AI・M21 から独立）。M21 の設計成果物（ArchitectureSpine / DesignSlice / IssueSpawnOrder）を **issue spawn 前**に評価し `DesignScorecard` を産出する | 北極星「評価可能」を設計層へ適用。設計が AI 著者である以上、自己評価でない独立審査が要る（M07 が M06 から独立するのと同じ原則・正本 §3） |
| D21 | M22 の主務は **全体整合性（大域 coherence）の審査**であり、スライス1枚ごとの局所品質採点ではない。審査軸: ① Tier1 内部整合 ② Tier1↔Tier2 整合（参照した決定に反する設計をしていないか）③ cross-slice 整合（前提と供給・interface・依存 DAG）④ 設計↔spec 意味的整合（集合被覆を超え AC 意図を満たすか・redLines 不侵犯）⑤ 全体目的整合（分割が epic ゴールへ向かう coherent な物語か） | 求めるのは局所レビューではなく全体との整合性。被覆/排他（集合演算）は必要だが「良い設計」には全く不十分——最悪の分割でも被覆は通る |
| D22 | `DesignScorecard` は **blocking / non-blocking 分離**。**blocking 基準 = 全体整合性違反**（実装を待たず確定判定できる: 相互矛盾・invariant 違反・参照先決定への背反・cross-slice 不一致・spec drift）→ designing へ差し戻し。**局所品質・改善提案は non-blocking** → 記録し層3へ携帯 | 整合性違反は今この時点で確定的に判定でき hard-block しても false-block にならない。一方、局所品質は「一部が実装まで不可知」ゆえ block すると良い設計を止める。gate の歯を steer したい整合性にちょうど一致させる。EvalScorecard と同構造（M01 共通化の布石） |
| D23 | epic 状態機械に審査点を挿入: `designing → design-reviewed → decomposed`。M22 は**完成をシグナル**するのみで、**状態ラベル書き込みは M03**（ADR-0001 の「状態遷移を LLM にやらせない」を踏襲）。blocking 非空なら M03 が `designing` へ戻す | 実装側の generate→evaluate→repair と対称な設計内側ループを作る。状態は決定的コードが持つ |
| D24 | **設計 repair は M21 の既存 drift 逆引き機構を再利用**（新機構を作らない）。`DesignScorecard` の各 finding は `sliceId` / `ARCH-ID` / `AC-ID` を指し、M21 はそれを逆引き（DSGN-FR-010/011 と同じ）して**該当箇所のみ**再設計する | 影響局所化の機構は既にある。設計差し戻しもそれに乗せれば新規実装が要らない |
| D25 | 層1（被覆かつ排他・ID 安定・参照実在・埋め込み禁止）は **M22 の決定的 grader tier** に吸収する。層2（整合性判断）は LLM/human tier。層3（事後）は設計起因失敗を `design_failure` として M10 Curator / M12 Analyst へ送る | 審査者がいるなら構造検証を M21 自己検証 / M03 に分散させず M22 に統合した方が単純。Evaluator の3段階 grader（決定的 / LLM / 人間）と同型 |

## 3. 確定した設計フロー（ADR-0001 §3 への差し込み）

ADR-0001 §3「設計・分解 M21 / M05」を以下に置き換える。

```text
【設計・分解 M21 / M22 / M05 — AI】
  ④ M21 Design Planner: 詳細設計（Tier1 スパイン / Tier2 スライス）+ PR サイズ分解（β）
       → IssueSpawnOrder（参照のみ・版固定）を出力＝設計完成をシグナル
  ④' M22 Design Reviewer（M21 から独立）: 設計成果物を spawn 前に審査
       決定的 tier（被覆/排他・ID・参照・埋め込み）+ 整合性 tier（大域 coherence）
       → DesignScorecard（blocking / non-blocking）
         · blocking 空     → M03 が design-reviewed → decomposed、issue 投稿
         · blocking 非空   → M03 が designing へ差し戻し
                             → M21 が finding の sliceId/ARCH-ID を逆引きし該当のみ再設計 ↺
         · non-blocking    → 記録し層3（design_failure taxonomy）へ携帯
  ⑤ epic:issue を投稿（M03）。resolve は M05（ADR-0001 のまま）
```

設計内側ループ（④↔④'）は、実装内側ループ（Generator→Evaluator→Repair）と対称。

## 4. 正本（REQUIREMENTS.md）との差分

- **新設モジュール M22 Design Reviewer**（AI・M21 から独立）。正本 §5.1 概念図の Development Department に
  設計審査の役割を追加する（実装対象内）。
- **§16 `failure_taxonomy` に `design_failure` を追加**（誤った分割・誤ったアーキ決定・設計↔spec 不整合の受け皿）。
  既存 taxonomy は M21 分離前に書かれ設計失敗の箱が無い。**本 ADR は接続点（D25・層3）を規定するに留め、
  正本への taxonomy 追記は別コミットで確認の上行う**（正本=SoT への編集は分離）。
- **新規契約 `DesignScorecard`**（M22 産・blocking/non-blocking・M01 抽出候補。EvalScorecard と同構造）。

## 5. M07 Evaluator との関係（なぜ別モジュールか）

M22 と M07 は「独立評価者が scorecard を産む」という**原則を共有**するが、別モジュールとする:

- 入力が違う: M07 = PR / GeneratorHandoff（実装成果）、M22 = 設計ドキュメント（Tier1/Tier2/spawn order）。
- 証拠の性質が違う: M07 は test 実行という決定的証拠を持つ。M22 は大域整合性の**判断**が主で、
  決定的 tier（構造検証）は持つが test 実行証拠は持たない（LLM/human grader に寄る）。
- タイミングが違う: M07 = 実装後、M22 = 実装前（shift-left）。

ただし `DesignScorecard` / `EvalScorecard` の **blocking/non-blocking 構造と grader 3段階は共通化候補**として
M01 へ抽出する（垂直1本通過後）。

## 6. 残 open

- `design_failure` taxonomy の正本追記（別コミット・要確認）。
- M22 の整合性 tier を担う grader の具体（LLM grader の判定基準・human escalation の発火条件）。M22 確定時。
- design 内側ループの試行上限・escalate 方針（実装側 M08 Repair Router と対称化するか）。M03/M08 確定時。
- `DesignScorecard` / `EvalScorecard` の M01 共通化（blocking/non-blocking envelope・grader tier）。
