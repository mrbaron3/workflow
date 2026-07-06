# ハンドオフ：execution 層 — 決定論ループ完成＋実 backend が無人 grounded 走行まで到達

> 別セッションで cold-start するための作業引き継ぎ（**transient**・作業完了後は削除可）。
> 作成: 2026-07-02 ／ 全面更新: 2026-07-05（決定論ループ完成・実 evaluator backend・無人 grounded 走行の実証を反映）
> 追記: 2026-07-05（**ライブ repair 完成** — 実 backend でも多 attempt repair ループが回る。決定論ループを mock/live 共有に抽出）
> 追記: 2026-07-05（**GitHub gate backend 完成** — `openGate`/`pollGate`・`PR.externalRef`・`config.gate`。既定 store 直・github opt-in。決定論テスト green。残: 使い捨て remote での grounded 実走）
> 追記: 2026-07-06（**並行パネル完成** — build を単一 commit に確定（`commitBuild`・amend）し、各 read-only レビューを build の分離 detached worktree で並行招集（`config.panel.maxConcurrent`）。AC-PANEL-008 が構造で成立。**副作用でゲートの実 push 空問題も解消**＝build が commit されるようになった）
> 追記: 2026-07-06（**横断掃除完成** — headless `claude -p` seam 撤去（`cli.ts`/`config.cli` 削除・`makeRunner` は mock 以外 throw・ADR-0005 Q2）＋旧 `run.ts`/`real-run.ts` 削除（live.ts が代替）＋scoped-context assembler 実装（`ARCH-execution-007`・`config.target.systemDir` opt-in））

## 一言で

**ハーネスが ai-managed issue を無人で「実装→実 tsc/vitest 採点→実レビュー→審査ゲート」まで自律駆動することを、実 Claude セッションで実証済み。** 決定論ループ（drive → 7観点 panel → repair×N → gate → human release）は全て実装・テスト green。実 backend（generator＋perspective セッション）も grounded 走行で無人完走を確認。**ライブ repair も実装済み**（generator セッションが repair brief を受け取り、worktree を再利用して多 attempt を回す・mock と同じ `runBoundedRepairLoop` を共有）。**GitHub gate backend も実装済み**（approve→PR 投影→merge/close をポーリングして `recordHumanDecision` へ・`gh` は seam の裏で決定論テスト済み）。**並行パネルも実装済み**（build を単一 commit に確定し、各レビューを分離 detached worktree で並行招集。AC-PANEL-008 は分離で構造的に成立。これで ゲートの実 push も非空に）。**横断掃除も一段落**（headless `claude -p` seam 撤去・旧 run.ts 削除・scoped-context assembler 実装）。残るのは実 backend の**幅の grounded 実走**（フル6観点・GitHub gate の使い捨て remote）と best-of-N（項5）。

**設計の一本の線**（不変）: seam の外側（poll/dispatch/grade/gate/store）は決定論コード、内側（HOW 遂行）だけが非決定な実セッション。headless 非目標・人間の判断点（署名＝WHAT／ゲート＝release）・状態は store、を守る。

## 最初に読むもの（canonical）

- [ADR-0005](../decisions/ADR-0005-execution-layer-tmux-orchestration.md) — 実装層 premises（P0-P5・L0-L2・Q1-Q3）。
- [ADR-0006](../decisions/ADR-0006-evaluator-panel-sessions-and-github-pr-gate.md) — パネル実行モデル（E1-E7）＋GitHub PR ゲート（G1-G3）。末尾に**実装先 id 表**（吸収済み／未の別）。
- [docs/specs/_system/execution/](../specs/_system/execution/) — 4ビュー。`ARCH-execution-NNN` が実装契約。ADR-0006 premises 吸収済み。
- [NORTH_STAR.md](../NORTH_STAR.md) — 自律×評価×改善／判断点／状態は store。
- 決定記録の吸収規約: [decisions/README.md](../decisions/README.md) §吸収の強制（採択 ADR は system view へ additive 吸収・逆参照）。

## 現状 done（このセッション・全て committed & pushed / origin `3e26ac4`）

決定論はすべて `npm test`（**168 green**）＋`npm run typecheck` で担保。各 spec は署名→to-detail-design→spawn→contract-draft→実装の自己ドッグフード。

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
| **ライブ repair**（generator が brief を受領・worktree 再利用・多 attempt。ループは mock/live 共有に抽出） | `loop.ts` `runBoundedRepairLoop`＋`session.ts` `buildGeneratorPrompt`＋`repair.ts` `toGenerateBrief` | `test/live-repair.test.ts`(5) | — |
| **GitHub gate backend**（approve→PR 投影→merge/close ポーリング→`recordHumanDecision`。git/`gh` は seam の裏・既定 store 直・github opt-in） | `src/pipeline/execution/gate.ts`（`openGate`/`pollGate`/`prStateToDecision`）＋`PR.externalRef`／`config.gate`＋`scripts/gate-poll.ts` | `test/github-gate.test.ts`(11) | — |
| **並行パネル**（build 単一 commit 確定＋分離 detached worktree で並行招集・AC-PANEL-008 構造成立・ゲート実 push 空も解消） | `worktree.ts`（`commitBuild`/`buildChangedFiles`/`createDetachedWorktree`）＋`perspective-session.ts`＋`pool.ts`＋`config.panel.maxConcurrent` | `test/build-commit.test.ts`(4)＋`test/pool.test.ts`(3) | — |
| **横断掃除**（headless `claude -p` seam 撤去・旧 run.ts 削除・scoped-context assembler） | `runner.ts`（`makeRunner` throw）＋`cli.ts`/`config.cli`/`run.ts`/`real-run.ts` 削除＋`scoped-context.ts`（`ARCH-execution-007`・`config.target.systemDir`）＋`session.ts` 配線 | `test/scoped-context.test.ts`(7) | — |

**実 backend の設計要点**: セッションが `.agentops/eval/<perspective>/findings.json` を産む（async・非決定）→ `sessionBackedGrader` がそれを読む（sync・決定論）→ `runPanel` 無改造。functionality は決定論 grader（E2）、6観点だけ LLM セッション。**各レビューは build commit の分離 detached worktree で並行招集**（`config.panel.maxConcurrent`）——findings は中央 evalRoot へ集約。read-only は**分離で構造保証**（レビューは build の worktree に触れられない＝AC-PANEL-008 成立）＋自分の checkout を編集したレビューは `changedFiles` で帰属 discard。

**grounded 走行の実証**（2回）:

1. 有人: 実 generator→roman.ts（実 vitest 4/4 pass）→ codeQuality レビュー approve → panel approve → gate → 人間承認 → released ＋ humanVerdict 記録。この走行が自律ギャップ2件を露呈。
2. **無人**: 同じスモークを承認プロンプト介入なしで完走（`genPrompt=0`/`evalPrompt=0`）。修正（generator に Bash・perspective に acceptEdits+Bash・`3e26ac4`）が無人自律を成立させた。

## 動かし方

```bash
# 決定論の確認
npm test           # 168
npm run typecheck
npx tsx .claude/skills/to-system-design/scripts/check-system-design.ts .harness/sysdesign-execution --system docs/specs/_system

# 実 Claude での grounded 走行（cost・claude 認証が要る）
npx tsx scripts/real-run-sandbox.ts                 # 使い捨て sandbox（roman）＋ ai-managed ISSUE-0001 ＋ config
LENSES=codeQuality npx tsx scripts/real-panel-run.ts # 安く1観点だけ（generator＋1レビュー）
npx tsx scripts/real-panel-run.ts                    # フル6観点
MAX_REPAIRS=1 npx tsx scripts/real-run-sandbox.ts    # ライブ repair を観測（request_changes→再 generate）。既定 0＝単発
# 走行中: tmux attach -t ao-issue-0001-s0（generator） / ao-eval-issue-0001-s0-<観点>（レビュー）
# ゲート承認（store 直・既定）: recordHumanDecision(store, issueId, 'approve'|'reject')（直接呼び／CLI 未整備）
# ゲート承認（github・opt-in）: config.gate.backend='github' で driveIssueLive が approve 時に PR 投影 → 人間が merge/close →
#   npx tsx scripts/gate-poll.ts でポーリングして released/repair へ反映。※実 GitHub PR を作る outward 動作
```

## 主要ファイル（execution）

- `guard.ts` — `pollable()` スコープガード（status==contract-drafted && assignedAgent==config.generator）。
- `tmux.ts` — セッション substrate ＋ `monitorLiveness`（sentinel＋pane 監視・stuck/timeout 昇格）。
- `session.ts` — generator セッション（Read/Edit/Write/**Bash**・acceptEdits）。完了時に build を単一 commit へ確定（`commitBuild`）し `buildChangedFiles` を返す。`buildGeneratorPrompt` は scoped-context（`config.target.systemDir` 設定時）も注入。
- `scoped-context.ts` — `ARCH-execution-007` assembler。`resolveSystemContext`（id→system view の定義行・pure・dangling は missing 顕在化）／`contextFor(issue, systemDir)`／`renderScopedContext`。id 参照を都度解決（コピーしない）。
- `worktree.ts` — worktree。`.agentops/` は git exclude。`commitBuild`（生成物を単一 build commit に・修正は `--amend`）／`buildChangedFiles`（`git diff HEAD^..HEAD`＝累積変更）／`createDetachedWorktree`（レビュー用の分離 checkout）。
- `pool.ts` — `mapPool(items, limit, fn)`：入力順保持の上限付き並行 map（`panel.maxConcurrent`）。
- `grade.ts` — 実 tsc/vitest → grounded BuildArtifact（AC は test 名の id 一致で満たす）。
- `perspective-session.ts` — findings 契約・parse・grader・prompt・`runPerspectiveSessions`（**並行**：各レビューを build の分離 detached worktree で走らせ・findings を中央 evalRoot へ集約・git worktree 操作は逐次でセッションのみ並行の3相・acceptEdits+Bash）。
- `loop.ts` — **`runBoundedRepairLoop`（mock/live 共有の決定論ループ・`produce` seam で各 attempt を差し込む）**・`driveIssueOnce`（mock backend の薄い wrapper）・`applyPanelVerdict`・`recordHumanDecision`・`driveOnce`・`watch`。
- `live.ts` — 実 backend 版 `driveIssueLive`/`runLoopLive`（`runBoundedRepairLoop` に real-session `produce` を渡す：generator セッション＋grounded＋perspective セッション＋panel＋gate。多 attempt repair・worktree 再利用・stuck→needs-human-review 昇格）。
- `gate.ts` — GitHub PR ゲート backend。`prStateToDecision`（純粋: merged→approve/closed→reject/open→pending）・`openGate`（approve→push＋`gh pr create`・`PR.externalRef` 記録・冪等）・`pollGate`（`needs-human-review`×github PR をポーリング→`recordHumanDecision`）・`GhGateRunner` seam（git/`gh` は裏・テストは fake）・`realGhGateRunner`。既定 `config.gate.backend=store`（no-op）・github は opt-in。ポーリングは `scripts/gate-poll.ts`。

## 残り（next・優先順）

1. **フル6観点の grounded 走行**（幅）: 今 grounded 検証は codeQuality 1観点のみ。`LENSES` 無指定で6観点を回し、
   security/type-design 等が実コードでどう割れるか観測。`PERSPECTIVE_LENS` に6観点分の焦点は既にある（`agents/evaluator-<観点>.md` の別ファイルは不要）。
2. ~~**ライブ repair**（深さ）~~ **✅ 完了**（このセッション）: `runGeneratorSession` が repair brief を受領し（`buildGeneratorPrompt` が
   プロンプトに載せる）、`runBoundedRepairLoop` を mock/live 共有に抽出したので `driveIssueLive` も `driveIssueOnce` と同じ多 attempt を回す。
   worktree 再利用で edits 累積・stuck generator は needs-human-review へ昇格（沈黙採点しない）。決定論テスト 5 本（`test/live-repair.test.ts`）。
   **未検証**: 実 Claude での repair 周回（`MAX_REPAIRS=1 npx tsx scripts/real-run-sandbox.ts` で観測できるが、roman は attempt 1 で収束しがち
   → lens が実際に request_changes を出す issue でないと repair 経路は踏まれない）。フル6観点の grounded 走行（項1）と併せて観測すると良い。
3. ~~**GitHub gate backend**（G1-G2 の HOW）~~ **✅ 完了**（このセッション）: `gate.ts` に `openGate`（approve→push＋`gh pr create`）／
   `pollGate`（merge/close を poll→`prStateToDecision`→`recordHumanDecision`）を実装。`PR.externalRef`（additive）で対応付け・`config.gate.backend`
   で store 直（既定・現状動作）と github を切替。git/`gh` は `GhGateRunner` seam の裏でテストは fake（11 本・`test/github-gate.test.ts`）。
   **未検証（残・要 opt-in）**: 実 remote での grounded 実走。sandbox はローカルのみ → `gh repo create` で使い捨て remote を作り
   `config.gate.backend='github'` にして driveIssueLive→PR 投影→手動 merge→`npx tsx scripts/gate-poll.ts` で released を確認する。
   **注意**: これは outward（実 GitHub リポジトリ/PR を作る）ので人間の明示 go が要る。既定 store のままなら一切外に出ない。
   なお reject の routing は `recordHumanDecision`（→changes-requested＝repair 車線）に従う。ADR G1 の「closed→needs-human-review」表現とは
   実装が決定論コア（既存）に合わせてある（closed=repair 差戻し・humanVerdict=request_changes 収穫）。ここを変えたいなら `recordHumanDecision` 側の論点。
4. ~~**並行パネル**~~ **✅ 完了**（このセッション）: build を単一 commit に確定（`commitBuild`・修正は `--amend`）し、各 read-only レビューを
   その build の**分離 detached worktree**で `mapPool`（`config.panel.maxConcurrent`）並行招集。AC-PANEL-008（採点は成果物を変えない）は分離で
   **構造的に**成立（レビューは build の worktree に触れられない）。git worktree の作成/破棄は逐次・セッションのみ並行の3相でレースを避ける。
   決定論テスト: `test/build-commit.test.ts`(4)＋`test/pool.test.ts`(3)。**副作用**: 生成物が commit されるので **項3 のゲート実 push 空問題が解消**。
   **未検証**: 実 Claude での並行招集（複数 tmux セッション同時）と worktree 増の負荷。フル6観点 grounded（項1）で観測。
5. **best-of-N / samples>1**: 今 live は単一 sample（pass^k 定義できず）。計測走行を issue 単位 opt-in で（E5・first-approve-stop 既定）。
6. ~~**横断掃除**~~ **✅ 完了**（このセッション）: (a) headless `claude -p` seam を撤去＝`cli.ts`（`CliAgentRunner`）と `config.cli`／`AgentCliConfig` 削除・
   `makeRunner` は mock 以外 throw（実 agent は live tmux 経路へ誘導・ADR-0005 Q2）・`agents/generator.md`／README の JSON-block/headless 記述も実態へ修正。
   (b) 旧 `run.ts`（`runExecutionOnce`）＋`real-run.ts` 削除（`live.ts`/`real-panel-run.ts` が代替）。(c) scoped-context assembler 実装
   （`scoped-context.ts`・`ARCH-execution-007`）: issue の `dependsOnSystem` を `config.target.systemDir` から都度解決し generator prompt へ注入（未設定なら no-op）。
   決定論テスト `test/scoped-context.test.ts`(7)。**未活用**: sandbox の roman issue に `dependsOnSystem` が無い＋`systemDir` 未設定なので実走では現状 no-op。
   dependsOnSystem を持つ issue（ハーネス自身の ISSUE-0003.. 等）を実 target にするときに効く。

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
