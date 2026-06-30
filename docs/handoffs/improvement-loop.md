# ハンドオフ：改善軸を実データで閉じる（北極星の三角形を完成）

> 別セッションで cold-start するための作業引き継ぎ（**transient**・作業完了後は削除可）。
> 作成: 2026-06-30

## 目的（なぜ）

item C 実走で **自律**（HOW を人手なく遂行）と **評価**（scorecard・pass@k）を実データで回した
（sign → system 層 → issue → spawn → contract-draft → `run`、3/3 released）。だが `run` しか実行しておらず、
**改善軸＝ `curate`／`analyze` を一度も走らせていない**。よって最優先操舵指標——**「同じ失敗を二度繰り返さない」
（失敗は必ず回帰評価ケースとして捕捉）**——が実データ上でまだ閉じていない。

このタスクは三軸の最後の一辺を埋める: 失敗を**回帰**へ、指標を**改善 issue**へ昇格させ、北極星の三角形
（自律 × 評価 × 改善）を実データで完成させる。

## 用語の正確な切り分け（誤解しやすい）

**「改善」= プロセス（ハーネス機構）自体の改善であって、計画の精度の改善ではない。**

- 北極星 §改善: 「評価から、**プロセス自体（grader / prompt / skill / routing / 新エージェント）が改善する**」。
- 改善されるのは grader 精度・prompt・skill・routing・eval カバレッジ。**どの feature を切るか（計画判断）は対象外**——
  それは roadmap-planner の判断で、契約化せず人間が握る（`planning-tree/spec.md` レッドライン）。
- 自動改善が触るのは HOW を遂行・評価する機構だけ。Analyst の改善 issue は計画の木に*乗る*が、それは
  「ハーネスが自分の機構改善を feature として同じロードマップで扱う」だけ。

## 最初に読むもの（canonical）

- [docs/NORTH_STAR.md](../NORTH_STAR.md) — §改善（grader/prompt/skill/routing）・操舵指標（同じ失敗を二度繰り返さない）。
- [docs/context-map.md](../context-map.md) — evaluation コンテキストが改善ループを所有。Curator/Analyst は evaluation→planning のフィードバック。
- [docs/specs/_system/evaluation/ubiquitous-language.md](../specs/_system/evaluation/ubiquitous-language.md) — Curator・Analyst・Eval Task Registry・pass@k・False pass/fail の定義。
- [README.md](../../README.md) §What you get from a run ＋ ループ図。

## 2つの機構（実装済み・走らせるだけ）

| 機構 | コード / CLI | 入力 | 出力 |
|---|---|---|---|
| **Curator** | `src/pipeline/curator.ts`・`agentops curate` | 実際の失敗（blocker findings） | Eval Task Registry に回帰を昇格（`store.db.evalTasks`） |
| **Analyst** | `src/pipeline/analyst.ts`・`agentops analyze [--create]` | 指標（instability・pass@1・false-pass 等） | `type:harness`/`type:eval` の改善 issue を提案（`--create` で計画の木へ起票） |

## 現状（引き継ぎ時点）

- item C の run 後の store（`.harness/db.json`・**gitignore・ローカル**）: issues 3 released・PR 9・evalRun 16。
  だが **`evalTasks`（回帰レジストリ）= 0**・**改善 issue = 0**（issues は story×3 のみ）。
- run では blocker 失敗が出て repair が発火した（"request_changes (1 blocker)"）。**curate が昇格できる失敗が現に存在する**。
- `.harness` は揮発（gitignore）。消えていたら下記でクリーンに再生成できる（決定論・mock）。

## 手順

0. **store を用意**（無い/古いとき）— item C の鎖をクリーンに再生成（mock・決定論）:

   ```bash
   rm -rf .harness
   npm run harness -- init
   npm run harness -- sign docs/specs/planning-tree     # spec は commit 済みクリーンが前提
   npm run harness -- spawn-issues docs/specs/planning-tree
   npm run harness -- contract-draft docs/specs/planning-tree
   npm run harness -- run                                 # blocker 失敗→repair が出る
   ```

1. **curate（失敗→回帰）**: `npm run harness -- curate` → `evalTasks` が増えることを確認。
2. **analyze（指標→改善 issue）**: まず `npm run harness -- analyze`（提案のみ表示）→ 妥当なら
   `npm run harness -- analyze --create` で `type:harness`/`type:eval` issue を起票。
3. **dashboard**: `npm run harness -- dashboard --open` → area×失敗型 heatmap・pass@k/pass^k・直近 scorecard を確認。
4. **検証**: 捕捉した回帰が実際の blocker 失敗に対応するか／改善 issue が grader・prompt・skill・routing を
   対象にしている（計画判断でない）か、を目視で確認。

## 落とし穴

- store は gitignore＝ローカル揮発。コミット対象でないので、状態が消えたら手順0で再生成（同一入力→同一結果）。
- backend は **mock（決定論）**。失敗・指標は模擬。改善ループの**機構は本物**だが、eval の基質が模擬なのは
  実エージェント backend（次タスク B）まで続く「honest MVP 境界」（README）。
- `analyze` は `--create` を付けて初めて起票する（無印は提案表示のみ）。
- 失敗が無い run には curate する材料が無い。item C の run は repair 込み＝材料あり。

## 完了の定義

- `evalTasks`（回帰レジストリ）> 0（実失敗から回帰を捕捉）。
- `type:harness`/`type:eval` の改善 issue が起票済み（`analyze --create`）。
- dashboard に heatmap ＋ pass@k/pass^k が出る。
- 「自律 × 評価 × 改善」の三軸すべてが実データで一度ずつ回った、と言える状態。

## この後の地平（参考・本タスク外）

- **B（次の大きな一歩）**: 実エージェント backend（実 CLI ＋対象リポジトリ ＋実 grader `npm test`）。
  模擬→実への飛躍・README の「honest MVP 境界」。
- **C（基質）**: doc-system backlog（supersedes の fold 機構・`_derived` の traceability/feature-catalog）。
  住処は [context-map.md](../context-map.md) の「未 first-class」節に記録済み。
