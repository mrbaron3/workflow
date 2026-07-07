# ADR-0007: ③改善ループの配線 — 提案は Analyst・WHAT 確定は人間の adopt・実行は既存 drive loop、self-hosting は env-gate 受け入れテストで守る

- 状態: 採択（**未吸収** — premises の `_system` ビュー吸収は追って行う。吸収先候補: `_system/execution` への additive 追記、
  または将来の `_system/improvement` コンテキスト新設。実装は本 ADR と同セッションの決定論スライスで着手済み）
- コンテキスト: improvement（③）。execution / evaluation の語彙（Verdict / EvalRun / EvalTask / pollable）を参照し再定義しない。
- 関連: [ADR-0001](ADR-0001-json-store-as-source-of-truth.md)（失敗・昇格・提案・採用の全てを store に写す）、
  [ADR-0004](ADR-0004-determinism-and-pluggable-backend.md)（Curator / Analyst / adopt / 計器は決定論コード）、
  [ADR-0006](ADR-0006-evaluator-panel-sessions-and-github-pr-gate.md)（審査ゲート＝人間。改善 issue も同じゲートを通る）

## 文脈

北極星の第三能力「改善可能」は Curator（失敗→回帰 EvalTask 昇格）と Analyst（metrics→改善提案）として
決定論実装・テスト済みだが、**ループとして閉じていない**。閉じない断線は構造的に2つある:

1. **Analyst の起票 issue が drive 不能** — `createSuggestionIssues` は `status: planned`・`contract: null`・
   `assignedAgent: null` で起票するが、実行層の poll 述語（`guard.ts` / `DOM-execution-006`）は
   `contract-drafted` かつ `assignedAgent == generator` のみ拾う。`contract-drafted` への既存経路
   `draftContracts` は署名 spec 前提で、harness/eval issue に spec は無い。
2. **self-hosting 経路が無い** — `type:harness` issue の HOW は**このリポジトリ自身の編集**だが、
   `config.target` は使い捨て sandbox を指す scaffold しか無い。また sandbox 流儀の
   「baseline-red の受け入れテスト」を main に置くと自分の CI（`npm test`）が壊れる。

加えて「いつ Curator/Analyst を回すか」「起票・採用を自動化するか」が未決だった（handoff 残課題）。

## 決定

### I1 改善 issue のライフサイクル: 提案（機械）→ adopt（人間の WHAT 確定）→ drive（自律）

- Analyst は**提案まで**: `analyze --create` で `planned`・contract 無しの `type:harness`/`type:eval` issue を
  起票する（この起票自体も人間のコマンド発行＝判断）。**起票の自動化はしない**（backlog 汚染防止。
  WHAT の自律は北極星の明示的非目標）。
- 人間が **`agentops adopt <ISSUE-ID> --contract <yaml>`** で WHAT を確定する。adopt は決定論コードで
  (a) IssueContract を Zod 検証して添付、(b) `planned → ready-for-contract → contract-drafted` を状態機械どおり遷移、
  (c) `assignedAgent = config.generator` を設定する。**adopt した瞬間に既存の poll 述語を満たし**、
  以降は feature issue と同一の drive loop（生成→パネル→ゲート）で自律遂行される — ハーネスが自分を直すのに
  専用経路を作らない（同じ roadmap・同じ loop、が③の核）。
- 審査は通常どおり人間ゲート（ADR-0006 G1）。改善 issue だからといってゲートは緩めない。

### I2 回すタイミング: Curator は live 常設・Analyst は report-only 常設

- **Curator は `runLoopLive` の各 turn 末尾に常設**する。冪等（既昇格 id はスキップ）・決定論・トークン費ゼロ
  なので毎 turn 安全。「見つけた失敗は必ず回帰 eval へ」（操舵星）を人手に依存させない。
- **Analyst は同じ場所で report-only 常設**（提案をログに出すだけ）。起票（`--create`）と adopt は I1 のとおり人間。
- mock 経路（`agentops run` / `demo`）は現状のまま（demo は既に curate+analyze を含む）。

### I3 self-hosting: `target.repo = '.'`、独立採点器は env-gate 受け入れテスト

- `type:harness` issue の grounded drive は **`config.target.repo = '.'`**（このリポジトリ自身の worktree）で行う。
  grader はリポジトリ自身の `tsc --noEmit` と `vitest run` — **既存スイート全 green が回帰網そのもの**になる。
- **env-gate 受け入れテスト規約**: harness 所有の受け入れテストは `test/acceptance-harness/` に置き、
  `describe.skipIf(!process.env.ACCEPT_HARNESS)` で覆う。通常の `npm test` では skip（main は常に green）、
  grader コマンドだけが `ACCEPT_HARNESS=1` を立てて実行する（baseline-red を CI に漏らさず sandbox と同じ
  「先に在る独立採点器」構造を成立させる）。この dir は `config.target.protectedPaths` で agent の編集から守る。
- そのために grader コマンド文字列は **sh 風の先頭 `KEY=VAL` env 代入をサポート**する（`grade.ts` の `run` は
  shell を介さないため、明示的に先頭トークンを env へ剥がす。決定論・テスト付き）。
- scaffold は `scripts/real-run-self.ts`。sandbox scaffold と違い **store を絶対に wipe しない**
  （失敗履歴・昇格済み EvalTask・adopt 済み issue こそがこの run の入力）。

### I4 操舵計器: regressionCaptureRate と falsePassTrend

- **`regressionCaptureRate`** = 観測された blocker AC 失敗ペア（issue×criterion）のうち Eval Task Registry に
  昇格済みの割合。操舵星「同じ失敗を二度繰り返さない」の**前半（捕捉）の直接計器**。失敗ゼロのときは null。
- **`falsePassTrend`** = humanVerdict 付き EvalRun の時系列に対する移動窓 false-pass 率。点値しか無かった
  `falsePassRate` に**推移**を与える（改善の before/after を語る物差し）。
- どちらも `computeMetrics` の決定論計算に追加し、status report / dashboard に表示する。

## 帰結

- ③のループの辺が全て決定論コードになり、人間の判断点は「起票の実行・adopt（WHAT）・ゲート（審査）」の
  3点に限定される — 北極星の役割分担（WHAT/承認/審査＝人間、HOW＝自律）と一致。
- 回帰 EvalTask の**実行**（registry → 再検証）は本 ADR の範囲外の次スライス（v0 案: `unit_test` method の
  task を source issue の target grader で再実行し AC-id 突合）。捕捉率の計器（I4）が先に立つので、
  実行が欠けている事実は dashboard 上で可視のまま残る。
- 最初の self-hosted 種 issue は ②の副次 finding「`scope_check` が `scope.exclude` を見ない」
  （`grade.ts` の include＋protectedPaths のみ判定）を採用する — 小さく・機械検証可能で、
  「ハーネスが自分のバグを自分で直す」一巡の実証に足る。

## 実装先

- adopt: `src/pipeline/adopt.ts`＋`agentops adopt`（CLI）。
- 常設配線: `src/pipeline/improve.ts`（`improveTick`）→ `runLoopLive` 末尾。
- env-gate: `src/pipeline/execution/grade.ts`（`run` の env 代入剥がし）＋ `test/acceptance-harness/`。
- scaffold: `scripts/real-run-self.ts`・種 contract: `scripts/seeds/scope-exclude.contract.yaml`。
- 計器: `src/metrics/metrics.ts`（`regressionCaptureRate`・`falsePassTrend`）＋ dashboard / status report。
- ゲート CLI: `agentops decide`（`recordHumanDecision` の薄いラッパ）・`agentops status --json`（前後比較スナップショット）。
