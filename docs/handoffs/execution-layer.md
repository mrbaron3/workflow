# ハンドオフ：execution 層（tmux オーケストレーション）を完成させる

> 別セッションで cold-start するための作業引き継ぎ（**transient**・作業完了後は削除可）。
> 作成: 2026-07-02 ／ 更新: 2026-07-05（ADR-0006 の premises と「詰まり所」を反映）

## 目的（なぜ）

「実 CLI backend を差し込んで実開発で回す」を、北極星に沿って実現する。設計対話で premises を固め
（[ADR-0005](../decisions/ADR-0005-execution-layer-tmux-orchestration.md)）、**実装層を独立コンテキスト**として
system 層に据え、**generator セッション1本＋実 grade** までを実データで通した（verdict approve）。
残りは evaluator パネル・審査ゲート・repair・watch デーモンを積むこと。

**設計の一本の線**: seam の外側（poll/dispatch/grade/store）は決定論コード、内側（HOW 遂行）だけが非決定な
実エージェント。headless 非目標・人間の判断点・状態は store という北極星の非交渉領域を、この境界で守る。

## 最初に読むもの（canonical）

- [docs/decisions/ADR-0005-...md](../decisions/ADR-0005-execution-layer-tmux-orchestration.md) — 確定した premises（P0-P5・L0-L2・Q1-Q3）。
- [docs/decisions/ADR-0006-...md](../decisions/ADR-0006-evaluator-panel-sessions-and-github-pr-gate.md) — パネル実行モデル（E1-E7）と GitHub PR ゲート（G1-G3）。task 11/12 はこの premises の実装。
- [docs/specs/_system/execution/](../specs/_system/execution/) — 4ビュー（language/domain/architecture/data）。`ARCH-execution-NNN` が実装の契約。
- [docs/context-map.md](../context-map.md) — execution は5番目のコンテキスト（言語境界・evaluation の採点語は参照）。
- [docs/NORTH_STAR.md](../NORTH_STAR.md) — headless 非目標・判断点・「状態は tmux でなく store」。

## 現状（done・committed）— origin より4コミット（このセッション分）

| commit | 内容 |
|---|---|
| `7f2b778` | 設計: ADR-0005 ＋ `_system/execution/` 4ビュー |
| `8528120` | runner: scoping guard・tmux セッション・worktree・実 grader |
| `18ccf02` | 初の実走行: 実 Claude が `roman.ts` 実装 → 実 tsc/vitest → approve。harness バグ2件を修正＋回帰テスト化 |
| `2f7b02f` | liveness: stuck セッションを needs-human-review へ昇格（無言終了しない） |

**検証済みの機構レシピ**（有人スモークで確認）:

```text
launch  tmux new-session -d -s <sess> -c <worktree> \
          "claude -n <sess> --permission-mode acceptEdits --allowedTools 'Read Edit Write'"
drive   tmux send-keys -t <sess> -l "<one-liner: PROMPT.md を読んで実装・完了で sentinel>" ; send-keys Enter
        （複数行プロンプトは送れない → 全文は worktree の .agentops/PROMPT.md に置き、agent に読ませる）
wait    monitorLiveness: sentinel(.agentops/done.json) を polling ＋ pane を並行監視
        pane が 90s 不変 ∧ sentinel 無し → stuck ／ 20m 超 → timeout ／ sentinel → completed
grade   completed のみ: 実 tsc/vitest を worktree に → grounded BuildArtifact → evaluate()
```

## 動かし方（reproduce・mock でなく実 Claude）

```bash
npx tsx scripts/real-run-sandbox.ts   # 使い捨て sandbox（roman）＋ ai-managed issue ＋ config を生成
npx tsx scripts/real-run.ts           # queue を poll → 実セッション → 実 grade → verdict
# 走行中: tmux attach -t ao-issue-0001-s0  でライブ観戦/介入（审查点）
```

- 決定論の確認: `npm test`（101）・`npm run typecheck`。
- system 層の整合: `npx tsx .claude/skills/to-system-design/scripts/check-system-design.ts .harness/sysdesign-execution --system docs/specs/_system`

## 主要ファイル

- `src/pipeline/execution/guard.ts` — `pollable()` スコープガード（ARCH-execution-002）
- `src/pipeline/execution/tmux.ts` — セッション substrate ＋ `monitorLiveness`（003/014）
- `src/pipeline/execution/worktree.ts` — worktree（004）。`.agentops/` は changedFiles から除外
- `src/pipeline/execution/session.ts` — generator セッション1本（003/005）
- `src/pipeline/execution/grade.ts` — 実 grader → grounded BuildArtifact
- `src/pipeline/execution/run.ts` — 最小 run entry（001 の薄い版）＋ liveness 顕在化
- `scripts/real-run-sandbox.ts` / `scripts/real-run.ts` — scaffold ＋ driver
- `agents/generator.md` — 実装エージェントの人格（`loadRolePrompt` が読む）。`AgentRole` enum が名簿

## 残りスライス（next）— premises は ADR-0006

1. **evaluator パネル（task 11）**: realises `ARCH-execution-006`。
   - 実行単位＝**観点ごとの独立 tmux セッション**（E1。サブエージェント方式は決定論境界・liveness と衝突するため不採用）。
   - **functionality は決定論 grader backend のまま**（E2）。LLM セッションは 6 観点（codeQuality / testQuality /
     ux / accessibility / security / type-design）のみ。**`agents/evaluator-<観点>.md` 6 本を著述**。
   - evaluator は read-only reviewer（E3）: 出力は `.agentops/eval/<perspective>/findings.json`（zod 検証）＋ sentinel。
   - 招集は hard gates 通過後のみ・全観点並行・`panel.maxConcurrent`（E4）。
   - 集約は決定論（E6・`DOM-execution-004`）。各観点 EvalRun に `EvalRun.perspective`（schema に既存）。
   - RepairBrief をパネル横断版に置換（E7）: blocker-first・criterionId 重複統合・発生源観点タグ・修復帰属の記録。
2. **審査ゲート＋repair＋watch（task 12）**:
   - Q3 人間審査ゲート＝**GitHub PR が UI**（G1-G2）: approve → push ＋ `gh pr create` → `needs-human-review` で停止
     → 人間 merge の poll 検知で `released`（今は approve で自動 released。`build-approved` 含む状態機械の遷移追加が要る）。`ARCH-execution-008`。
   - **ゲート判定を `EvalRun.humanVerdict` へ自動記録**（G3・ラベル収穫）: merge＝true-pass／差戻し＝false-pass。
     falsePassRate の較正セットが運用から育つ（改善ループの起点）。
   - repair ループ: `runGeneratorSession` は attempt>1 で worktree 再利用済み。パネル横断 repair brief を prompt に載せ再 drive。
   - watch デーモン: `runExecutionOnce` を poll ループで包む常駐（`ARCH-execution-001`・L1）。実 backend 既定は
     samples=1・first-approve-stop（E5。best-of-N は計測 opt-in）。
   - scoped-context 組立（`ARCH-execution-007`・P5）: 今は generator.md＋contract 全体。木の `dependsOnSystem` から最小化。
3. **system 層への反映（task 11/12 と同時）**: `_system/execution` 4 ビューへ ADR-0006 の premises を追記
   （to-system-design。パネル実行単位・ゲート UI・ラベル収穫の ARCH/DATA id）。`config.cli` の `claude -p` 既定を除去（Q2 残債）。

## 実装で詰まりそうなところ（先に知っておく穴）

1. **「1 attempt＝1 EvalRun」前提の reader たち** — パネル後は 1 attempt に観点数の EvalRun がぶら下がる
   （`DATA-execution-001`・集約値は保存せず派生）。`src/metrics/metrics.ts`（pass@k/pass^k の分母）・
   `src/pipeline/curator.ts`（findings 走査 → 観点数だけ重複昇格する）・`src/dashboard/dashboard.ts` が
   `perspective ≠ null` を区別しないと数が壊れる。改修は「sample の verdict は集約関数から引く」の一点に寄せる。
2. **`buildRepairBrief` が単一 EvalRun 前提**（`src/pipeline/repair.ts`）— パネル横断版に置換（E7）。観点間で
   矛盾する指摘の優先順位は blocker-first ＋ 発生源観点タグで機械的に扱う（LLM に裁定させない）。
3. **sentinel / worktree の衝突** — generator の sentinel は `.agentops/done.json`。evaluator 6 セッションが同じ
   worktree を読むため、出力は観点別パス `.agentops/eval/<perspective>/` に分離（E3）。evaluator に Edit/Write を
   許すと worktree 汚染・scope_check 誤検知の事故になる（read-only tool 制限が本質）。`.agentops/` の changedFiles
   除外は既存（回帰テスト `test/execution-worktree.test.ts`）。
4. **LLM が書く findings.json の検証失敗パス** — zod parse 失敗は「1 回 re-drive → だめなら needs-human-review」
   （E3）。**静かに skip して approve 側へ倒すのが最悪**（false-pass 製造機になる）。`ARCH-execution-015` の精神で必ず昇格。
5. **GitHub PR ゲートは remote 前提** — 今の sandbox（`scripts/real-run-sandbox.ts`）はローカルのみ。
   (a) `gh repo create` で使い捨て remote を作る scaffold 拡張、(b) remote が無い target は store 直のゲート
   （`needs-human-review` 停止・CLI 承認）に fallback、のどちらかを先に決める。`gh` 認証が前提。store との対応は
   `PR.externalRef`（additive）。merge 検知は poll（webhook 無し・L1 と同型）。
6. **`build-approved` が状態機械に無い** — `DOM-execution-007` が参照するが `src/domain/states.ts` に未定義。
   遷移: `evaluation-in-progress → build-approved → needs-human-review →（人間承認）released`。今の coordinator は
   approve で自動 released（`src/pipeline/coordinator.ts:113-115`）— **ここを断つのが Q3 の本体**。
7. **samples=1 での計測の縮退** — first-approve-stop（E5）では pass^k が定義できない。metrics の headlineK は
   「実測に存在する k」から引く。best-of-N 計測走行は issue 単位の opt-in フラグで区別する。
8. **並行 6 セッションの資源制約** — `monitorLiveness`（`src/pipeline/execution/tmux.ts`）は単一セッション監視の形。
   パネルには複数セッション同時監視のループが要る。tmux セッション数・rate limit の飽和は `panel.maxConcurrent`（E4）で抑える。
9. **`config.cli` に `claude -p` 既定が残存**（`src/config.ts` の DEFAULT_CONFIG）— ADR-0005 Q2 で deprecate 済みの
   headless 経路。パネル配線と同時に消さないと「二つの真実」になる。

## 落とし穴

- `.harness/` は **gitignore・ローカル揮発**（store・sandbox・worktrees・evidence）。消えても scaffold で再生成（決定論）。
- **`.agentops/` は harness 自身の足場**（PROMPT.md・sentinel）。`changedFiles` は除外する（初回走行で scope 誤検知したバグ・回帰テスト `test/execution-worktree.test.ts` で固定）。
- `vitest.config.ts` が **`.harness/**` を除外**（sandbox/worktree のテストを harness 自身の suite が拾わないため）。
- **headless（`claude -p`）は使わない**（北極星非目標）。対話セッション＋acceptEdits＋tool 制限が「auto 起動」。
- **オーケストレータは決定論コード**（LLM でない）。poll/dispatch/grade/store を LLM に委ねない。
- **Hermes backend は forward-ref**（AgentRunner seam の裏の将来 backend・orchestrator には据えない）。採用時は curl でなく mise http backend でマニフェスト化。
- ローカル store の ISSUE-0001 は今 `needs-human-review`（バグ入り EVAL-00001 の名残）。クリーンな approve は再走行で再生成（再 grade では approve 確認済み）。
- **tmux 3.7 導入済み**（brew・`~/.Brewfile` に宣言済み）。

## 完了の定義（残りスライス）

- 7観点パネル（LLM 6 観点＋functionality 決定論）が 1 sample を採点し、集約 verdict が `DOM-execution-004` で
  派生する（`EvalRun.perspective` が観点数ぶん付く。metrics/curator が観点 run を二重計上しない）。
- approve で GitHub PR が立ち `needs-human-review` で止まる。人間 merge の検知で `released`、差戻しで
  `EvalRun.humanVerdict` に false-pass が記録される（Q3・G1/G3）。
- watch が ai-managed queue を連続処理する（実 backend 既定 samples=1・first-approve-stop）。
- すべて `npm test` green・system 層 check OK を保つ。

## push 状況

- **未 push**: `main` は origin/main より **12 コミット先行**（このセッション4本＋以前8本）。
- remote: `git@github.com:mrbaron3/workflow.git`。引き継ぎには push が必要（`.harness` はローカルなので code のみ共有）。
