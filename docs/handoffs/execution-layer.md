# ハンドオフ：execution 層 — 全機能実装済み＋grounded 実証済み。残るは「repair の実走観測」のみ

> 別セッションで cold-start するための引き継ぎ（**transient**・完了後は削除可）。作成: 2026-07-06。
> 前回このファイルは「完了」で一度削除したが、repair loop の grounded 観測の実験が継続中のため再作成。

## 一言で

execution 層は**設計・実装・決定論テストが完了**し、実 Claude セッションで **end-to-end 実証済み**:
ai-managed issue を無人で「実装（実セッション）→ 実 tsc/vitest 採点 → 6観点並行レビュー → 審査ゲート →
人間 release → humanVerdict 較正」まで自律駆動する。決定論は `npm test`（**180+ green**）＋`npm run typecheck`
＋system-design check で担保。すべて origin/main に push 済み（`git log --oneline` 参照）。

**残タスクは実質1つ**: 「live repair loop の**発火**を grounded で観測する」。機構は決定論テスト済みだが、実走行で
発火させるには attempt 1 が落ちる必要があり、強い generator（Opus 4.8）× 簡単な課題（roman）では稀。→ `HARD` mode
（repair-bait）を仕込み中（下記）。

## 最初に読むもの（canonical）

- [ADR-0005](../decisions/ADR-0005-execution-layer-tmux-orchestration.md)（実装層 premises・P/L/Q）＋
  [ADR-0006](../decisions/ADR-0006-evaluator-panel-sessions-and-github-pr-gate.md)（パネル E1-E7・GitHub ゲート G1-G3。**末尾の実装先 id 表**が地図）。
- [docs/specs/_system/execution/](../specs/_system/execution/) 4ビュー — `ARCH/DOM/DATA/LANG-execution-NNN` が実装契約（ADR premises 吸収済み）。
- [NORTH_STAR.md](../NORTH_STAR.md) — 自律×評価×改善／判断点は署名（WHAT）とゲート（release）／状態は store。

## 実装済み（このセッション・全て committed & pushed）

`git log --oneline` の execution: コミット群。主なもの:

- **live repair**（`loop.ts` `runBoundedRepairLoop`＋`live.ts` `runLiveSample`）: 実 backend でも多 attempt repair。
- **GitHub gate backend**（`gate.ts` `openGate`/`pollGate`/`prStateToDecision`・`PR.externalRef`・`config.gate`。既定 store 直・github opt-in・`scripts/gate-poll.ts`）。
- **並行パネル**（`worktree.ts` `commitBuild`/`buildChangedFiles`/`createDetachedWorktree`＋`perspective-session.ts`＋`pool.ts` `mapPool`・`config.panel.maxConcurrent`）: build を単一 commit 確定し各レビューを分離 detached worktree で並行招集。AC-PANEL-008 は分離で構造成立。
- **横断掃除**: headless `claude -p` seam 撤去（`cli.ts`/`config.cli` 削除・`makeRunner` は mock 以外 throw）・旧 `run.ts`/`real-run.ts` 削除・**scoped-context assembler**（`scoped-context.ts`・`ARCH-execution-007`・`config.target.systemDir` opt-in・sandbox に roman 設計層を種として仕込み済み）。
- **best-of-N**（`loop.ts` `runBestOfN`・既定 samples:1＋first-approve-stop・`MEASURE=1` で pass@k/pass^k）。
- **grounded 実走で発見した2バグを修正**: (1) `sendPrompt` の submit race（Enter 取りこぼし→typed-but-unsent→stuck）を submit-and-verify retry で解消（`tmux.ts`・`PaneDriver` seam）。(2) worktree 作成が stale dir に非冪等（`worktree.ts` `clearWorktree` で解消）。両方 決定論テスト付き。

## grounded 実走の知見

- **end-to-end 完走**: roman.ts を実 Claude が実装（scoped-context の設計 id をコード comment で引用＝設計を遵守）→ 実 tsc/vitest で functionality=1.0 → 6観点パネル → ゲート → 人間 approve で released → falsePassRate/graderAgreement 較正 populate。
- **パネルは差別化した評価をする**: ある走行で testQuality が `request_changes`（他5観点 approve）→ blocker観点1つの反対で aggregate が request_changes（`DOM-execution-004`・スコア平均で相殺しない）。
- **grader 非決定性**: **同一同等コード・同じ 2-3 findings に対し testQuality が request_changes / approve / approve と3走行で揺れた（≈1/3 で割れる）**。これは欠陥でなく **G3 humanVerdict 収穫で較正すべき一級データ**。
- **escalate-over-false-pass の実証**: type-design が stuck（プロンプト未 submit）で verdict 無し → 6観点 approve でも panel は**握り潰さず escalate**（`ARCH-execution-015`）。stuck セッションは kill せず生かした（`ARCH-execution-014`）。この2件が上記バグ修正のきっかけ。

## 動かし方（grounded は cost・claude 認証が要る）

```bash
npm test && npm run typecheck                                    # 決定論の確認（180+）
npx tsx .claude/skills/to-system-design/scripts/check-system-design.ts .harness/sysdesign-execution --system docs/specs/_system

npx tsx scripts/real-run-sandbox.ts                             # 使い捨て sandbox（roman）＋ ai-managed ISSUE-0001
LENSES=codeQuality npx tsx scripts/real-panel-run.ts            # 安く1観点・全観点は LENSES 無指定
SAMPLES=3 MEASURE=1 npx tsx scripts/real-panel-run.ts          # best-of-N 計測（pass@k/pass^k）
# ゲート: recordHumanDecision(store, 'ISSUE-0001', 'approve'|'reject')（CLI 未整備・tsx で直呼び）
```

### repair loop の grounded 観測（進行中の実験）

repair は attempt 1 が `request_changes` のときだけ発火する。強い generator × roman では稀なので **`HARD` mode**
（repair-bait）を追加した: AC-3 の strict cases（小文字・前後/内部の空白・非正準形の**拒否**）を**受け入れテストにだけ**
置き、contract の AC-3 は terse なまま。入力を正規化（trim/toUpperCase）する「寛容」実装は attempt 1 で AC-3 を落とし、
attempt 2 が締め直す——という賭け（**確定ではない**: strict parsing を最初から選ぶ generator は attempt 1 で通る）。

```bash
HARD=1 MAX_REPAIRS=1 npx tsx scripts/real-run-sandbox.ts        # repair-bait を仕込む（attempts=2）
LENSES=testQuality npx tsx scripts/real-panel-run.ts           # 安く回す（functionality が gate。testQuality は1観点）
# attempt 1 が request_changes なら: ログに "↻ request_changes → repair"、EvalRun に attempt=1,2 の両方、
#   attempt 2 の generator が brief 付きで worktree 再利用して修正 → approve or 上限で escalate。
# 落ちなければ（attempt 1 で approve）: 運任せなので数回引く or full panel（LENSES 無指定）で発火率↑。
```

**別解**: full panel（6観点）＋`MAX_REPAIRS=1` は「どれか1観点が dissent」で発火するので単観点より当たりやすい（が ~7-14 セッションと高コスト）。あるいは決定論テスト（`test/repair-loop.test.ts`・`test/live-repair.test.ts`）で機構は既に green＝「発火の実走観測」は nice-to-have。

**実験結果（2026-07-06・4走行）**: attempt 1 は**4/4 で approve**。`HARD` bait すら不発 — generator（Opus 4.8）は terse な「reject malformed input」だけから**最初から canonical-form 正規表現で strict 実装**し（scoped-context の `DOM-roman-002` を根拠にコメントで小文字/空白/非正準を列挙）、bait が前提にした「寛容な正規化」を選ばなかった。**結論: この generator × この課題クラスでは repair の grounded 発火を安定に誘発できない**（機構は決定論テストで実証済み）。grounded で見たいなら (a) より弱い generator（例 haiku）に落とす、(b) 本当に難しい/曖昧な課題を種にする、(c) 決定論の実証で十分とする、のいずれか。皮肉だが「scoped-context が効いて generator が堅牢になった」ことが bait を難しくした側面もある。

## 落とし穴・不変条件

- `.harness/` は **gitignore・ローカル揮発**（store・sandbox・worktrees・review-worktrees・evidence）。scaffolder で決定論再生成。store の issue/eval はローカルのみ（共有されない）。
- **grounded だけが暴くバグがある**（mock はプロンプトを出さない）。今回の2バグ（submit race・worktree 非冪等）が実例。substrate は self-verify させ、`monitorLiveness` を never-silent の最後の砦にする。
- **escalate over false-pass**（`ARCH-execution-015`）: 観点の出力欠落/不正は握り潰さず `needs-human-review` へ。6/7 approve でも1つ欠ければ escalate。
- **liveness surfacing**（`ARCH-execution-014`）: stuck セッションは kill/timeout せず生かす（`tmux attach` で人間が引き継ぐ）。
- **headless 非目標**: 実 agent は対話 tmux セッション（`claude -n`）。`claude -p` は使わない・`makeRunner` は mock 以外 throw。
- **オーケストレータは決定論**: poll/dispatch/grade/gate/store を LLM に委ねない。`agentops run`（coordinator）は mock demo 用の別経路（approve→自動 released）で execution 層の live 経路と混同しない。
- 環境: tmux 3.7・claude 2.1.x（Opus 4.8）。generator worktree=`ao-issue-*-s*`、review=`ao-eval-issue-*-s*-<観点>`。
