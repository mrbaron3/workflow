# ハンドオフ：execution 層（tmux オーケストレーション）を完成させる

> 別セッションで cold-start するための作業引き継ぎ（**transient**・作業完了後は削除可）。
> 作成: 2026-07-02

## 目的（なぜ）

「実 CLI backend を差し込んで実開発で回す」を、北極星に沿って実現する。設計対話で premises を固め
（[ADR-0005](../decisions/ADR-0005-execution-layer-tmux-orchestration.md)）、**実装層を独立コンテキスト**として
system 層に据え、**generator セッション1本＋実 grade** までを実データで通した（verdict approve）。
残りは evaluator パネル・審査ゲート・repair・watch デーモンを積むこと。

**設計の一本の線**: seam の外側（poll/dispatch/grade/store）は決定論コード、内側（HOW 遂行）だけが非決定な
実エージェント。headless 非目標・人間の判断点・状態は store という北極星の非交渉領域を、この境界で守る。

## 最初に読むもの（canonical）

- [docs/decisions/ADR-0005-...md](../decisions/ADR-0005-execution-layer-tmux-orchestration.md) — 確定した premises（P0-P5・L0-L2・Q1-Q3）。
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

## 残りスライス（next）

1. **evaluator パネル（task 11）**: 7観点（grader 5次元＋security＋type-design）を独立セッションで fan-out →
   集約（`DOM-execution-004`: blocker 観点が1つでも request_changes なら request_changes）。各観点 EvalRun に
   `EvalRun.perspective` を立てる（既に schema にある）。**`agents/evaluator-<観点>.md` を著述**（security/type-design は未定義）。realises `ARCH-execution-006`。
2. **審査ゲート＋repair＋watch（task 12）**:
   - Q3 人間審査ゲート: approve → `needs-human-review` → 人間承認で `released`（今は approve で自動 released。状態機械の遷移追加が要る）。`ARCH-execution-008`。
   - repair ループ: `runGeneratorSession` は attempt>1 で worktree 再利用済み。repair brief を prompt に載せ再 drive。
   - watch デーモン: `runExecutionOnce` を poll ループで包む常駐（`ARCH-execution-001`・L1）。
   - scoped-context 組立（`ARCH-execution-007`・P5）: 今は generator.md＋contract 全体。木の `dependsOnSystem` から最小化。

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

- 7観点パネルが1 sample を採点し集約 verdict を出す（`EvalRun.perspective` が観点数ぶん付く）。
- approve が `released` でなく人間審査ゲートで止まり、承認で released（Q3）。
- watch が ai-managed queue を連続処理する。
- すべて `npm test` green・system 層 check OK を保つ。

## push 状況

- **未 push**: `main` は origin/main より **12 コミット先行**（このセッション4本＋以前8本）。
- remote: `git@github.com:mrbaron3/workflow.git`。引き継ぎには push が必要（`.harness` はローカルなので code のみ共有）。
