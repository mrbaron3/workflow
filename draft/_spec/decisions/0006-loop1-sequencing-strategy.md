# 決定記録 0006: loop 1 を閉じる着手戦略（評価スパイク先行 × 背骨並行・計画権威の一本化）

- 状態: 保留・参考（2026-06-23 前提見直しにより取り下げ。スコープ過大／計画未完で前のめりと判断）
- 最終更新: 2026-06-23
- 影響モジュール: M03 Coordinator / M09 Evaluation Harness / M07 Evaluator /
  M21 Design Planner / M22 Design Reviewer / M05 resolve / M10 Eval Curator（いずれも loop 1 範囲）
  ＋ docs/ROADMAP.md の位置づけ
- 由来: ブレスト [../../_brainstorm/2026-06-23-north-star-loop1-decisions.yaml](../../_brainstorm/2026-06-23-north-star-loop1-decisions.yaml)
  のクラスタ c_strat / c_scope を critical-path 優先で深堀

## 1. 背景

北極星（自律 × 評価 × 改善）の完成は horizon であり、反証可能なマイルストーンは **loop 1**
（[../README.md](../README.md) §8）。だが二つの計画文書が「次の一手」で別方向を指す：

- [docs/ROADMAP.md](../../../docs/ROADMAP.md) "Suggested next step" → **実 grader 先行**
  （tiny repo に実 grader を1本、既存 runner で 1 issue 通す）。
- [../README.md](../README.md) §8 / [../loop1-walkthrough.md](../loop1-walkthrough.md) §7 →
  **自律の前半・背骨先行**（M05 resolve → M03 Coordinator）。

さらに ROADMAP は旧 AgentOps（参考実装）の v0–v3 staging で、ADR-0001/0004 の三層設計
（M20–M22）を反映していない。順序の正本を決めないと深堀のたびに手戻りする。あわせて
「loop 1 で設計層（M21/M22）をどこまで作り込むか」（[../README.md](../README.md) §8 末尾 ⚠️）も未決。

## 2. 提案する決定（理由つき）

| # | 決定 | 理由 |
| --- | --- | --- |
| D1 | 順序の正本を **spec README §8 + loop1-walkthrough（目標アーキ）** に一本化。docs/ROADMAP.md は **参考に降格**（旧 AgentOps roadmap）。食い違いは spec 側が優先 | README 冒頭「実装を仕様に合わせる」。ROADMAP は M20–M22 三層を反映しない旧 staging |
| D2 | 着手は **二トラック並行**。(A) **M09 実 grader スパイク**を最優先 de-risk として先行（tiny target repo か手作り PR に api_test/unit を実コマンドで1本通す）。(B) **M03 背骨の spec** を並行起票。両者が出会う点で loop 1 を閉じる | 操舵点「実 failure を回帰化」は実評価を要し mock failure は回帰価値が薄い。だが実 PR 採点には背骨→生成が要る鶏卵関係 → 最大の未知（実 grader）を先に潰し、背骨 spec と並行で critical path を短縮。ROADMAP も「real grader が mock/prod 間の最大の壁」と認める |
| D3 | loop 1 の設計層は **最薄**。**M22 は決定的 tier のみ**（被覆/排他/参照実在/additive/DAG 非循環）。整合性 tier（LLM 5軸 rubric）は loop 2。**M21 三層は additive な system 層を必要分 ＋ slice 分解まで** | loop 1 は最薄の縦 1 本が原則。設計層の作り込みは未実証仮説への投資。README §8 ⚠️ をこの方向で確定 |
| D4 | loop 1 の最初の実機能は **loop1-walkthrough の Todo due 例**。閉じたらドッグフードで「次に作りたい機能」を spec.md に流す | 通し図が既に端から端まで具体化済みで、内側ループと drift を見せられる＝実装の受け入れ例になる |
| D5 | loop 1 完了基準（固定・再掲）: 1 機能が人間の HOW 無しで PR 化 → **実 grader の証拠で採点** → **その失敗が回帰 eval に昇格**。満たすまで loop 1 は閉じていない | 北極星の反証「失敗が回帰化されない」を loop 1 で潰す |
| D6 | M01 共通契約モデルの抽出は **loop 1 を閉じた後**（実際に現れた契約から）。先に作らない | ADR-0001 D1「抽象は具体の後」と整合 |

## 3. 深堀ターゲットの順序（この決定が規定する）

```text
P1 着手戦略（本 ADR）
  ├─ track A: M09 実 grader スパイク（P3 で詰める）──┐
  └─ track B: M03 背骨 spec（P2 で詰める）──────────┤→ 出会う点で loop 1 を閉じる
P4 改善（失敗の回帰化・薄）
P5 前半確定（M20/M21/M22/M05・並行・既に下書き）
（loop 2）M01 抽出 / 横断 / domain / viz / metrics
```

## 4. 正本（REQUIREMENTS.md）/ 既存 ADR との差分

- **docs/ROADMAP.md の位置づけ**: 権威 → **参考**へ降格（D1）。実際の改訂/注記は別タスク（doc hygiene）。
- 既存 ADR との関係: 本 ADR は ADR-0002（独立設計レビュ）/ ADR-0004（三層設計）を loop 1 で
  **最薄に運用する**方針（D3）であり、設計内容自体は変更しない。

## 5. 反映先（マップ正規化）

ブレストマップ c_strat / c_scope の点に `status: decided` ＋ 本 ADR への `decisionRef` を付す：
p1, p2, p3, p4, p28, p29, p31, p33, p34。

## 6. 未決事項 / 決定ログ

残 open（後続の深堀で回収）:

- M09 スパイクの **target repo の具体選定**（既存 tiny / 専用 sandbox / ハーネス自身）→ P3。
- M03 **状態機械二段の細部**（ラベル排他・ロック粒度・worktree・dispatch・DAG 消費）→ P2。
- docs/ROADMAP.md の実改訂（参考への注記追加）→ doc hygiene タスク。
- p30 予算 / p32 完了の観測 tooling は metrics（loop 2）。
