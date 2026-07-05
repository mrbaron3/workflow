# ハンドオフ：execution 層 — 決定論ループ完成＋実 backend が無人 grounded 走行まで到達

> 別セッションで cold-start するための作業引き継ぎ（**transient**・作業完了後は削除可）。
> 作成: 2026-07-02 ／ 全面更新: 2026-07-05（決定論ループ完成・実 evaluator backend・無人 grounded 走行の実証を反映）

## 一言で

**ハーネスが ai-managed issue を無人で「実装→実 tsc/vitest 採点→実レビュー→審査ゲート」まで自律駆動することを、実 Claude セッションで実証済み。** 決定論ループ（drive → 7観点 panel → repair×N → gate → human release）は全て実装・テスト green。実 backend（generator＋perspective セッション）も grounded 走行で無人完走を確認。残るのは実 backend の**幅と深さ**（フル6観点・ライブ repair・GitHub gate）と横断掃除。

**設計の一本の線**（不変）: seam の外側（poll/dispatch/grade/gate/store）は決定論コード、内側（HOW 遂行）だけが非決定な実セッション。headless 非目標・人間の判断点（署名＝WHAT／ゲート＝release）・状態は store、を守る。

## 最初に読むもの（canonical）

- [ADR-0005](../decisions/ADR-0005-execution-layer-tmux-orchestration.md) — 実装層 premises（P0-P5・L0-L2・Q1-Q3）。
- [ADR-0006](../decisions/ADR-0006-evaluator-panel-sessions-and-github-pr-gate.md) — パネル実行モデル（E1-E7）＋GitHub PR ゲート（G1-G3）。末尾に**実装先 id 表**（吸収済み／未の別）。
- [docs/specs/_system/execution/](../specs/_system/execution/) — 4ビュー。`ARCH-execution-NNN` が実装契約。ADR-0006 premises 吸収済み。
- [NORTH_STAR.md](../NORTH_STAR.md) — 自律×評価×改善／判断点／状態は store。
- 決定記録の吸収規約: [decisions/README.md](../decisions/README.md) §吸収の強制（採択 ADR は system view へ additive 吸収・逆参照）。

## 現状 done（このセッション・全て committed & pushed / origin `3e26ac4`）

決定論はすべて `npm test`（**138 green**）＋`npm run typecheck` で担保。各 spec は署名→to-detail-design→spawn→contract-draft→実装の自己ドッグフード。

| 層 | 実装 | テスト | 署名 spec / issue |
|---|---|---|---|
| **評価パネル**（7観点 fan-out・gate-before-panel・resume・集約・昇格） | `src/pipeline/panel.ts` | `test/panel.test.ts`(12) | evaluator-panel(9AC) / ISSUE-0003/4/5 |
| 観点横断 repair 指示 | `src/pipeline/repair.ts` `buildPanelRepairBrief` | 同上 | 同上 |
| reader 整合（metrics/curator が観点 run を二重計上しない） | `src/metrics/metrics.ts` `perSample` | 同上 | 同上 |
| **自律ドライブ＋審査ゲート**（humanVerdict 収穫・冪等） | `src/pipeline/execution/loop.ts`＋`states.ts` `build-approved` | `test/execution-loop.test.ts`(11) | execution-loop(8AC) / ISSUE-0006/7 |
| **修復ループ**（収束 or 上限昇格＝「3回」要求） | `loop.ts` `driveIssueOnce` 多 attempt | `test/repair-loop.test.ts`(4) | repair-loop(4AC) / ISSUE-0008 |
| **systemRefs 修正**（sign が dependsOn を固定・ISSUE-0002 解消） | `src/authoring/source.ts` `parseDependsOn`＋`cli/index.ts` | `test/authoring-sign.test.ts` 回帰 | — |
| **実 evaluator backend（seam）** | `src/pipeline/execution/perspective-session.ts` | `test/perspective-session.test.ts`(8) | — |
| **ライブ配線** | `src/pipeline/execution/live.ts`＋`scripts/real-panel-run.ts` | grounded 走行 | — |

**実 backend の設計要点**: セッションが `.agentops/eval/<perspective>/findings.json` を産む（async・非決定）→ `sessionBackedGrader` がそれを読む（sync・決定論）→ `runPanel` 無改造。functionality は決定論 grader（E2）、6観点だけ LLM セッション。read-only は権限でなく**構造**で保証（走行後 `changedFiles` ガードがコード編集レビューを discard）。

**grounded 走行の実証**（2回）:

1. 有人: 実 generator→roman.ts（実 vitest 4/4 pass）→ codeQuality レビュー approve → panel approve → gate → 人間承認 → released ＋ humanVerdict 記録。この走行が自律ギャップ2件を露呈。
2. **無人**: 同じスモークを承認プロンプト介入なしで完走（`genPrompt=0`/`evalPrompt=0`）。修正（generator に Bash・perspective に acceptEdits+Bash・`3e26ac4`）が無人自律を成立させた。

## 動かし方

```bash
# 決定論の確認
npm test           # 138
npm run typecheck
npx tsx .claude/skills/to-system-design/scripts/check-system-design.ts .harness/sysdesign-execution --system docs/specs/_system

# 実 Claude での grounded 走行（cost・claude 認証が要る）
npx tsx scripts/real-run-sandbox.ts                 # 使い捨て sandbox（roman）＋ ai-managed ISSUE-0001 ＋ config
LENSES=codeQuality npx tsx scripts/real-panel-run.ts # 安く1観点だけ（generator＋1レビュー）
npx tsx scripts/real-panel-run.ts                    # フル6観点
# 走行中: tmux attach -t ao-issue-0001-s0（generator） / ao-eval-issue-0001-s0-<観点>（レビュー）
# ゲート承認: recordHumanDecision(store, issueId, 'approve'|'reject')（今は直接呼び／CLI 未整備）
```

## 主要ファイル（execution）

- `guard.ts` — `pollable()` スコープガード（status==contract-drafted && assignedAgent==config.generator）。
- `tmux.ts` — セッション substrate ＋ `monitorLiveness`（sentinel＋pane 監視・stuck/timeout 昇格）。
- `session.ts` — generator セッション（Read/Edit/Write/**Bash**・acceptEdits）。
- `worktree.ts` — worktree。`.agentops/` は changedFiles 除外。
- `grade.ts` — 実 tsc/vitest → grounded BuildArtifact（AC は test 名の id 一致で満たす）。
- `perspective-session.ts` — findings 契約・parse・grader・prompt・`runPerspectiveSessions`（read-only 逐次・acceptEdits+Bash）。
- `loop.ts` — `driveIssueOnce`（多 attempt repair）・`applyPanelVerdict`・`recordHumanDecision`・`driveOnce`・`watch`。
- `live.ts` — 実 backend 版 `driveIssueLive`/`runLoopLive`（generator セッション＋grounded＋perspective セッション＋panel＋gate）。
- `run.ts` — 旧・薄い単一観点 run（`runExecutionOnce`）。live.ts に置換されつつある（後述）。

## 残り（next・優先順）

1. **フル6観点の grounded 走行**（幅）: 今 grounded 検証は codeQuality 1観点のみ。`LENSES` 無指定で6観点を回し、
   security/type-design 等が実コードでどう割れるか観測。`PERSPECTIVE_LENS` に6観点分の焦点は既にある（`agents/evaluator-<観点>.md` の別ファイルは不要）。
2. **ライブ repair**（深さ）: `runGeneratorSession` は repair brief を受け取らない → `driveIssueLive` は単一 attempt。
   generator プロンプトに repair brief を載せ、`driveIssueOnce` と同じ多 attempt を live でも回す。`buildPanelRepairBrief` は実装済み。
3. **GitHub gate backend**（G1-G2 の HOW）: 今 `recordHumanDecision` は直接呼び。`gh pr create`＋人間 merge の poll 検知を
   `recordHumanDecision` へ変換する seam。remote・`gh` 認証前提／`PR.externalRef`（additive）で対応付け。sandbox はローカルのみ →
   (a) `gh repo create` で使い捨て remote、(b) remote 無しは store 直ゲート（現状）に fallback、を選ぶ。
4. **並行パネル**: `runPerspectiveSessions` は逐次（read-only 違反の帰属のため）。`panel.maxConcurrent` で並行化（E4）。
   `monitorLiveness` は単一セッション監視なので複数同時監視ループが要る。
5. **best-of-N / samples>1**: 今 live は単一 sample（pass^k 定義できず）。計測走行を issue 単位 opt-in で（E5・first-approve-stop 既定）。
6. **横断掃除**: `config.cli` の `claude -p` 既定を除去（ADR-0005 Q2 残債・DEFAULT_CONFIG）。`run.ts` の薄い単一観点 run を live.ts に統合。
   scoped-context 組立（`ARCH-execution-007`・P5）: 今は generator.md＋contract 全体、木の `dependsOnSystem` から最小化。

## 落とし穴・不変条件

- `.harness/` は **gitignore・ローカル揮発**（store・sandbox・worktrees・evidence）。消えても scaffold で決定論再生成。
  → **store の issue/eval は共有されない**（ISSUE-0003..0008 はローカルのみ・code は commit 済み）。ハーネス自身の backlog を durable にするかは未決の設計論点。
- **`.agentops/` は harness の足場**（PROMPT.md・sentinel・eval/<観点>/findings.json）。changedFiles 除外済み（回帰 `test/execution-worktree.test.ts`）。
- **findings.json 検証失敗は昇格**（`ARCH-execution-015`）: parse 失敗→1回 re-drive→なお不可なら needs-human-review。**静かに approve へ倒さない**（false-pass 製造機になる）。`runPanel` の `gradeWithRetry` が実装。
- **detached セッションは承認で無言停止する**（grounded 走行の教訓）: 必要 tool は先付け（generator=Bash 追加、perspective=acceptEdits+Bash）。無人自律の要。この種のバグは**決定論テストでは出ない**（mock はプロンプトを出さない）——grounded 走行だけが暴く。
- **headless（`claude -p`）不使用**（北極星非目標）。対話セッション＋acceptEdits＋tool 制限が「auto 起動」。
- **オーケストレータは決定論**。poll/dispatch/grade/gate/store を LLM に委ねない。
- **`agentops run`（coordinator.ts）は別経路**: mock demo 用で approve→自動 released。execution 層の `driveOnce`/`driveIssueLive` はゲートで止める。混同しない。
- tmux 3.7 導入済み（brew・`~/.Brewfile`）。claude 2.1.x。

## push 状況

- origin/main = `3e26ac4`、**未 push 0**（このセッション分は全て push 済み）。
- remote: `git@github.com:mrbaron3/workflow.git`。`.harness` はローカルなので code のみ共有。
