# ハンドオフ：北極星の次フロンティア＝③改善ループを grounded で閉じる（Curator/Analyst）

> 別セッションで cold-start するための引き継ぎ（**transient**・完了後は削除可）。作成: 2026-07-07。
> 前段の [execution-layer.md](execution-layer.md) の残タスク（repair loop の grounded 観測）は**解消済み**——
> 本ハンドオフはその次、北極星の三能力のうち残る **③改善** を指す。execution-layer.md は「完了した参照記録」
> として残す（削除してもよい・中身は commit 履歴＋ADR/_system に写っている）。

## 一言で

北極星（[NORTH_STAR.md](../NORTH_STAR.md)）＝**自律 × 評価 × 改善**。このうち **①自律・②評価は grounded で骨格が立った**
（このセッションで repair loop の**発火も収束も実走観測**＝自律ループが閉じた）。**残る本丸は③「改善」の自律化**：
失敗を回帰 eval ケースへ昇格し、grader/prompt/skill/routing がその証拠から改善する Curator/Analyst 経路。
**重要**: ③は greenfield ではない——`src/pipeline/curator.ts`（失敗→回帰 EvalTask 昇格）と `src/pipeline/analyst.ts`
（metrics→harness/eval 改善 issue 起票）は**決定論実装済み＋CLI 配線済み**。**足りないのは "live 経路への配線" と
"改善ループが一巡する grounded 観測"**——execution の repair がセッション開始時にいたのと同じ段階。

## 北極星スコアカード（現在地・正直な採点）

| 能力 | 状態 | 根拠 / 欠け |
|---|---|---|
| ①自律 | 🟢 中核 grounded | issue を人間が HOW に触れず 実装→採点→パネル→ゲート→release まで駆動。repair は発火・収束を実走確認。欠け: 1 issue・1 課題クラス規模。上流（planning→spec→design→issue）一気通貫は未実証。 |
| ②評価 | 🟢 良好 | 実 tsc/vitest＝証拠採点・7観点パネル・escalate-over-false-pass・humanVerdict 較正・PromptRecord 監査。欠け: false-pass率↓は humanVerdict 蓄積待ち（数点のみ）。 |
| ③改善 | 🟡 決定論実装済み・**loop 未閉** | Curator/Analyst 実装＋CLI 配線済み。欠け: **live 経路に未配線**（CLI/mock 手動のみ）・**実失敗→昇格→改善→計測の一巡が grounded 未観測**。 |

操舵指標（最優先）＝**「同じ種類の失敗を二度繰り返さない」**（失敗を回帰評価ケースへ捕捉）。

## 最初に読むもの（canonical）

- [NORTH_STAR.md](../NORTH_STAR.md) — 三能力・操舵指標・反証サイン。
- [execution-layer.md](execution-layer.md) — 前段ハンドオフ（execution 層の grounded 詳細・pitfalls・動かし方＝**この層は完了・参照用**）。
- `src/pipeline/curator.ts`（`curateEvalTasks`）／`src/pipeline/analyst.ts`（`analyzeHarness`・`createSuggestionIssues`）／`src/metrics/metrics.ts`（Analyst の入力）。
- `src/cli/index.ts` の `cmdCurate`／`cmdAnalyze`（既存の手動一巡経路）。
- ADR-0006・[_system/evaluation](../specs/_system/evaluation/) ビュー（改善は `type:harness`/`type:eval` issue として同じ roadmap に載る＝ハーネスが同じ loop で自分を直す）。

## このセッションで完了したこと（全て `origin/main`・作業ツリー clean）

`git log --oneline` の該当群:

- `00df909` per-role モデル選択（`config.models.{generator,reviewer}` → `claude --model`・純関数 `buildLaunchCommand`）。
- `6238da4` haiku 実験（当時 repair 不発の記録）。
- `bac40ef` **PromptRecord**（発行プロンプトを store へ監査射影・`DATA-execution-006`）。
- `71b446c` **repair loop の grounded 発火観測**（landmark・従来結論を反転）。
- `b85b18f` **scope_check テンション修正**（sandbox 契約 scope を `test/**` へ拡張）。
- `d5badec` **tmux タブ表示**（holder セッション `agentops`・各ロールを window 化・`tmux attach -t agentops`）。
- `8dd7f17` handoff 追記（repair 収束＋タブ機能）。

決定論は **191 tests green**＋`npm run typecheck`＋system-design check で担保。

## 次にやること（③改善ループを grounded で閉じる最短経路）

**ゴール**: 実失敗 → Curator が回帰 EvalTask へ昇格 → Analyst が harness 改善 issue（`type:harness`/`type:eval`）を起票 →
その issue を execution 層で駆動 → metrics（pass@k/pass^k・false-pass率）で改善を確認、という一巡を **grounded で一度回して観測**する
（execution の repair 観測と同じ流儀：機構は決定論で在る→実走で loop が閉じるのを見る）。

**最初の"種"はこのセッションの実失敗**（既に store/handoff にある一級データ）:

- **scope_check テンション**（`testQuality` が scope 外テストを要求→修正済みだが**回帰 eval 化されていない**）。契約 lint か回帰ケースへ昇格する候補。
- **grader 非決定性**（`testQuality` が同等コードで approve/request_changes に ~1/3 揺れる）。humanVerdict 較正データ＝Analyst が「stabilise」を提案すべき入力。

**具体ステップ案**:

1. Curator/Analyst を **live 経路へ配線するか、まず CLI（`cmdCurate`/`cmdAnalyze`）で手動一巡する**かを判断（`agentops run`＝mock demo と execution の live 経路を混同しない）。
2. Curator/Analyst の**専用決定論テスト**を補強（現状 metrics.test.ts 経由で薄い・要確認）。
3. **grounded で一巡観測**: 実 panel run で失敗を作る → curate で EvalTask 昇格 → analyze `--create` で harness issue → その issue を drive → metrics 前後比較。
4. 操舵指標の計器化: 「同じ失敗が回帰化された率」「false-pass率の推移」を dashboard/metrics に出す。

## 落とし穴・不変条件（③に効くもの）

- **改善はハーネス自身の loop で回す**（ADR-0006）: Analyst の提案は `type:harness`/`type:eval` issue として同じ roadmap に載り、execution 層が駆動する。別経路を作らない。
- **状態は store**（北極星の反証「状態が tmux や人の頭にある」を踏まない）: 失敗・昇格・改善は全て EvalRun/EvalTask/Issue に写す。PromptRecord も監査基質。
- **回帰化されない失敗は"改善が外れているサイン"**（NORTH_STAR 反証）: 見つけた失敗を直すだけで終わらせず、回帰 eval へ昇格する。
- **副次 finding（未修正・害なし）**: `scope_check` は `scope.exclude` を見ず `include`＋`protectedPaths` のみで判定（`grade.ts:103-108`）＝`scope.exclude` は grader 上は飾り。grader 仕様判断が要るなら別途。

## 動かし方

```bash
npm test && npm run typecheck                                    # 決定論（191 green）
npx tsx .claude/skills/to-system-design/scripts/check-system-design.ts .harness/sysdesign-execution --system docs/specs/_system

# 改善ループの手動一巡（既存 CLI 経路・要 build/CLI 確認）
#   curate: 失敗した blocker AC を回帰 EvalTask へ昇格   （cmdCurate）
#   analyze --create: metrics から harness/eval 改善 issue を起票（cmdAnalyze）

# grounded execution（②の証拠を作る・cost・claude 認証が要る）
npx tsx scripts/real-run-sandbox.ts                             # 使い捨て sandbox＋ai-managed ISSUE-0001
LENSES=testQuality npx tsx scripts/real-panel-run.ts            # 安く1観点
GEN_MODEL=haiku HARD=1 MAX_REPAIRS=1 ...                        # repair を発火させたいとき（弱コーダ×bait）
tmux attach -t agentops                                         # ライブ観察（各ロールがタブ・完了で自動クローズ）
```

- 環境: tmux 3.7・claude 2.1.x（既定 Opus 4.8。`config.models` で role 別上書き可）。セッションは holder `agentops` の window。
- `.harness/` は gitignore・ローカル揮発（store・sandbox・worktrees・evidence）。scaffolder で再生成。
