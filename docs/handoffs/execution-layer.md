# ハンドオフ：execution 層 — 全機能実装済み＋grounded 実証済み（repair の実走発火も観測済み）

> **2026-08-05 path移設注記**: 本文の旧`src/`・`test/`・`scripts/`・`agents/`は
> `apps/agentops/`配下に対応する。実験時のscopeとcommandは歴史として保持し、現行の実装pathと
> 実行入口はroot README／runbook／
> [ADR-0021](../decisions/ADR-0021-go-typescript-application-boundaries.md)を正とする。

<!-- blockquote separator -->

> 別セッションで cold-start するための引き継ぎ（**transient**・完了後は削除可）。作成: 2026-07-06。
> 前回このファイルは「完了」で一度削除したが、repair loop の grounded 観測の実験が継続中のため再作成。
> **2026-07-06 追記: repair loop の grounded 発火を観測（`GEN_MODEL=haiku HARD=1 MAX_REPAIRS=1` の 1 走行目）。長らくの残タスクは解消。以降は真の transient。**

## 一言で

execution 層は**設計・実装・決定論テストが完了**し、実 Claude セッションで **end-to-end 実証済み**:
ai-managed issue を無人で「実装（実セッション）→ 実 tsc/vitest 採点 → 6観点並行レビュー → 審査ゲート →
人間 release → humanVerdict 較正」まで自律駆動する。決定論は `npm test`（**180+ green**）＋`npm run typecheck`
＋system-design check で担保。すべて origin/main に push 済み（`git log --oneline` 参照）。

**この残タスクは解消済み**: 「live repair loop の**発火**を grounded で観測する」を達成。経緯: 機構は決定論テスト済み
だが実走発火には attempt 1 の request_changes が要る。`HARD` bait だけでは Opus 4.8 も Haiku も**厳格実装**を選んで
不発（下記実験結果）。**option (a)**（`config.models.generator` で generator だけ弱いモデルに落とす `--model` 配線）を
実装し、`GEN_MODEL=haiku HARD=1 MAX_REPAIRS=1` を回したところ**1 走行目で発火**した（下記「発火観測」）。
発火の実体は functionality の hard-fail ではなく **testQuality（Opus）の request_changes**——弱い haiku が
canonical round-trip check を欠いた実装を書き、strong reviewer が**コードを実行して**非正準受理バグ（`fromRoman('IIX')=10` 等）を
突いた。**弱いコーダ × 強い敵対的レビュアの dissent** が発火条件。機構・`config.models`・prompt 監査（下記）は全て稼働。

## 最初に読むもの（canonical）

- [ADR-0005](../decisions/ADR-0005-execution-layer-tmux-orchestration.md)（実装層 premises・P/L/Q）＋
  [ADR-0006](../decisions/ADR-0006-evaluator-panel-sessions-and-github-pr-gate.md)（パネル E1-E7・GitHub ゲート G1-G3。**末尾の実装先 id 表**が地図）。
- [_system/execution/](../_system/execution/) 4ビュー — `ARCH/DOM/DATA/LANG-execution-NNN` が実装契約（ADR premises 吸収済み）。
- [NORTH_STAR.md](../NORTH_STAR.md) — 自律×評価×改善／判断点は署名（WHAT）とゲート（release）／状態は store。

## 実装済み（このセッション・全て committed & pushed）

`git log --oneline` の execution: コミット群。主なもの:

- **live repair**（`loop.ts` `runBoundedRepairLoop`＋`live.ts` `runLiveSample`）: 実 backend でも多 attempt repair。
- **GitHub gate backend**（`gate.ts` `openGate`/`pollGate`/`prStateToDecision`・`PR.externalRef`・`config.gate`。既定 store 直・github opt-in・`apps/agentops/scripts/gate-poll.ts`）。
- **並行パネル**（`worktree.ts` `commitBuild`/`buildChangedFiles`/`createDetachedWorktree`＋`perspective-session.ts`＋`pool.ts` `mapPool`・`config.panel.maxConcurrent`）: build を単一 commit 確定し各レビューを分離 detached worktree で並行招集。AC-PANEL-008 は分離で構造成立。
- **横断掃除**: headless `claude -p` seam 撤去（`cli.ts`/`config.cli` 削除・`makeRunner` は mock 以外 throw）・旧 `run.ts`/`real-run.ts` 削除・**scoped-context assembler**（`scoped-context.ts`・`ARCH-execution-007`・`config.target.systemDir` opt-in・sandbox に roman 設計層を種として仕込み済み）。
- **best-of-N**（`loop.ts` `runBestOfN`・既定 samples:1＋first-approve-stop・`MEASURE=1` で pass@k/pass^k）。
- **grounded 実走で発見した2バグを修正**: (1) `sendPrompt` の submit race（Enter 取りこぼし→typed-but-unsent→stuck）を submit-and-verify retry で解消（`tmux.ts`・`PaneDriver` seam）。(2) worktree 作成が stale dir に非冪等（`worktree.ts` `clearWorktree` で解消）。両方 決定論テスト付き。
- **per-role モデル選択**（option (a) 実装）: `config.models.{generator,reviewer}` → 各セッションの `claude --model`。純関数 `buildLaunchCommand`（`tmux.ts`）に切り出して決定論テスト（`apps/agentops/test/launch-command.test.ts`）。既定 undefined＝ユーザ既定モデル継承（＝従来挙動）。無効モデルは pre-validate せず claude に投げて `monitorLiveness` が stuck として surface（never-silent 方針）。sandbox は `GEN_MODEL`/`REVIEW_MODEL` env で opt-in。`config.models` 素通し（`loadConfig`）を `apps/agentops/test/config.test.ts` で固定。
- **発行プロンプトの監査保全**（`PromptRecord`・`DATA-execution-006`）: Session は揮発（`DOM-execution-002`）で `.agentops/PROMPT.md` は repair ごとに上書き＋wipe されるので、attempt 1 の本文と repair brief が失われていた。それを store（`DB.promptRecords`・additive `default([])`）へ**監査射影**として写す（実行時揮発性は不変）。1 行＝`(issue, sample, attempt, role)`＋`model`/`outcome`/本文インライン。seam の上（`live.ts` の `runLiveSample`）で書き、session 層は本文を返すだけ（`SessionResult.prompt`）。stuck attempt は EvalRun を生まないので `outcome` 付きの唯一の足跡。決定論テスト `apps/agentops/test/prompt-record.test.ts`。上記「発火観測」で実走実証。
- **sandbox scope 拡張**（scope_check テンション修正・option A）: `apps/agentops/scripts/real-run-sandbox.ts` の契約 `scope.include` を `['src/**','test/**']` に（`test/acceptance/**` は protected 維持）。役割プロンプトの「テスト追加」命令と scope の矛盾を解消し、testQuality 起点の repair が **approve まで収束**できるように（上記「発火観測」の派生 finding 参照）。fixture のみ・共有プロンプト/本番コードは不変。
- **tmux タブ表示**（`tmux.ts` の substrate 変更）: 各ロールを独立セッションでなく**単一 holder セッション `WINDOW_HOLDER`（既定 `agentops`・env 上書き可）のウィンドウ（タブ）**として起こす。`tmux attach -t agentops` 一発で全 generator/reviewer をタブ一覧。完了タブは `killSession`→`kill-window` で閉じ、**stuck は残す**（`ARCH-execution-014`＝そのタブで人間が引き継ぐ）。常駐 `home` タブで holder を延命（最後のロールタブが閉じても死なない）。`buildLaunchCommand`（純関数）は不変＝決定論テスト無影響（191 green）。tmux レベル smoke で検証。設計は元々「its own tmux window」表現＝矛盾なし。

## grounded 実走の知見

- **end-to-end 完走**: roman.ts を実 Claude が実装（scoped-context の設計 id をコード comment で引用＝設計を遵守）→ 実 tsc/vitest で functionality=1.0 → 6観点パネル → ゲート → 人間 approve で released → falsePassRate/graderAgreement 較正 populate。
- **パネルは差別化した評価をする**: ある走行で testQuality が `request_changes`（他5観点 approve）→ blocker観点1つの反対で aggregate が request_changes（`DOM-execution-004`・スコア平均で相殺しない）。
- **grader 非決定性**: **同一同等コード・同じ 2-3 findings に対し testQuality が request_changes / approve / approve と3走行で揺れた（≈1/3 で割れる）**。これは欠陥でなく **G3 humanVerdict 収穫で較正すべき一級データ**。
- **escalate-over-false-pass の実証**: type-design が stuck（プロンプト未 submit）で verdict 無し → 6観点 approve でも panel は**握り潰さず escalate**（`ARCH-execution-015`）。stuck セッションは kill せず生かした（`ARCH-execution-014`）。この2件が上記バグ修正のきっかけ。

## 動かし方（grounded は cost・claude 認証が要る）

```bash
npm test && npm run typecheck                                    # 決定論の確認（180+）
npx tsx .claude/skills/to-system-design/scripts/check-system-design.ts .harness/sysdesign-execution --system docs/specs/_system

npx tsx apps/agentops/scripts/real-run-sandbox.ts                             # 使い捨て sandbox（roman）＋ ai-managed ISSUE-0001
LENSES=codeQuality npx tsx apps/agentops/scripts/real-panel-run.ts            # 安く1観点・全観点は LENSES 無指定
SAMPLES=3 MEASURE=1 npx tsx apps/agentops/scripts/real-panel-run.ts          # best-of-N 計測（pass@k/pass^k）
# ゲート: recordHumanDecision(store, 'ISSUE-0001', 'approve'|'reject')（CLI 未整備・tsx で直呼び）
```

### repair loop の grounded 観測（進行中の実験）

repair は attempt 1 が `request_changes` のときだけ発火する。強い generator × roman では稀なので **`HARD` mode**
（repair-bait）を追加した: AC-3 の strict cases（小文字・前後/内部の空白・非正準形の**拒否**）を**受け入れテストにだけ**
置き、contract の AC-3 は terse なまま。入力を正規化（trim/toUpperCase）する「寛容」実装は attempt 1 で AC-3 を落とし、
attempt 2 が締め直す——という賭け（**確定ではない**: strict parsing を最初から選ぶ generator は attempt 1 で通る）。

```bash
# 本命（option a）: 弱い generator × repair-bait。弱いコーダは attempt 1 で締め切れず repair を踏みやすい。
GEN_MODEL=haiku HARD=1 MAX_REPAIRS=1 npx tsx apps/agentops/scripts/real-run-sandbox.ts   # generator だけ haiku・reviewer は既定(強)
LENSES=testQuality npx tsx apps/agentops/scripts/real-panel-run.ts           # 安く回す（functionality が gate。testQuality は1観点）
# 参考（bait のみ・Opus 4.8 では不発だった）: HARD=1 MAX_REPAIRS=1 npx tsx apps/agentops/scripts/real-run-sandbox.ts
# attempt 1 が request_changes なら: ログに "↻ request_changes → repair"、EvalRun に attempt=1,2 の両方、
#   attempt 2 の generator が brief 付きで worktree 再利用して修正 → approve or 上限で escalate。
# 落ちなければ（attempt 1 で approve）: さらに弱いモデル or full panel（LENSES 無指定）で発火率↑。
```

**別解**: full panel（6観点）＋`MAX_REPAIRS=1` は「どれか1観点が dissent」で発火するので単観点より当たりやすい（が ~7-14 セッションと高コスト）。あるいは決定論テスト（`apps/agentops/test/repair-loop.test.ts`・`apps/agentops/test/live-repair.test.ts`）で機構は既に green＝「発火の実走観測」は nice-to-have。

**実験結果（2026-07-06・4走行）**: attempt 1 は**4/4 で approve**。`HARD` bait すら不発 — generator（Opus 4.8）は terse な「reject malformed input」だけから**最初から canonical-form 正規表現で strict 実装**し（scoped-context の `DOM-roman-002` を根拠にコメントで小文字/空白/非正準を列挙）、bait が前提にした「寛容な正規化」を選ばなかった。**結論: この generator × この課題クラスでは repair の grounded 発火を安定に誘発できない**（機構は決定論テストで実証済み）。grounded で見たいなら (a) より弱い generator（例 haiku）に落とす、(b) 本当に難しい/曖昧な課題を種にする、(c) 決定論の実証で十分とする、のいずれか。皮肉だが「scoped-context が効いて generator が堅牢になった」ことが bait を難しくした側面もある。

**追記（option a を実装＋grounded 実走・2026-07-06）**: `config.models.generator`（＋sandbox の `GEN_MODEL` env）で generator セッションだけ弱いモデルに落とせるようにし、`GEN_MODEL=haiku HARD=1 MAX_REPAIRS=1 → LENSES=testQuality` を実走した。**モデル上書きは grounded で機能**（generator pane に `Haiku 4.5`・review pane に `Opus 4.8` を確認＝role 別 `--model` 配線が実セッションを駆動）。**だが repair はまた不発**: Haiku の attempt 1 も**厳格実装**（`fromRoman` が `/^[IVXLCDM]+$/` で小文字/空白を弾き、`toRoman(result) !== s` の canonical round-trip check で `IIII`/`IXIX` 等を弾く）で HARD 受け入れテストを全通過 → functionality=approve(1.0)、testQuality も approve(0.9・minor 1件のみ：`fromRoman` の out-of-range guard `roman.ts:74-76` を直接突く受け入れケースが無い、という鋭い指摘) → EvalRun は attempt=1 のみ・needs-human-review。**弱いモデルでも発火しなかった**のは、scoped-context が round-trip（`LANG-roman-001`）と canonical form（`DOM-roman-002`）を prompt に注入する＝**モデルを弱めても設計シグナルは弱まらない**ため（Opus で見た皮肉が Haiku でも再現）。全セッション clean teardown（submit-race・worktree 冪等の修正が保持・stuck 無し）。**結論の更新: この課題クラスでは generator を haiku に落としても repair の grounded 発火は誘発できない**。発火を実走で見たいなら残る手は (b) 本当に曖昧/難しい課題を種にする（例: 仕様が terse で「寛容 vs 厳格」がコイントス・かつ scoped-context に厳格判断の根拠を置かない）か、あるいは testQuality の ~1/3 dissent を引くまで full panel を複数回引く。**機構自体は決定論テストで実証済み**（`repair-loop`・`live-repair`）なので grounded 発火は依然 nice-to-have。

**発火観測（2026-07-06・landmark）**: 上の「複数回引く」を実行——`GEN_MODEL=haiku HARD=1 MAX_REPAIRS=1 → LENSES=testQuality`
を最大8回ループ（各回 sandbox を wipe して独立・attempt=2 の generator PromptRecord が出たら break）したところ**1 走行目で発火**。
連鎖: attempt 1 は functionality=approve(1.0) だが、この回の Haiku は前回と違い **canonical round-trip check を欠いた実装**を書いた
（generator 非決定性）→ testQuality（Opus）が**コードを実行して**非正準受理バグ（`fromRoman('IIX')=10`・`'IXX'=19`・`'MCMM'=2900`）を
発見し **request_changes(0.6)**（2 findings）→ 機構が 2-fix の repair brief を生成（ログ `↻ request_changes → repair (2 fix(es))`）→
**attempt 2 の generator が brief 付きで発火**（PromptRecord attempt=2・`model='haiku'`・本文 6286 字＝attempt 1 の 4018 字＋`## Repair` 節）。
attempt 2 は **scope_check（blocker）で gate-fail → needs-human-review**（converge せず）。

- **教訓**: 発火条件は「functionality の hard-fail」ではなく **弱いコーダ × 強い敵対的レビュアの dissent**。前段の不発は Haiku が
  たまたま strict 実装を選んだから。generator 非決定性ゆえ**単観点でも数回引けば ~1/3 で dissent → 発火**する（今回は 1 回で当たった）。
- **prompt 監査（`PromptRecord`）がこの実験の計測器になった**: attempt=2 の存在＝発火の判定に使い、repair brief 本文もそのまま保全。
  上書き・wipe される PROMPT.md では消えていた brief が store に残る＝機能の価値が実走で実証。
- **派生 finding → 調査＋修正済み（2026-07-07）**: attempt 2 の gate-fail は **testQuality の brief が「テスト追加」を要求するのに contract の
  `scope.include` が `src/**` のみ**という**自己矛盾の契約**が原因だった（役割プロンプト `apps/agentops/agents/generator.md` も「Add automated tests for each」と「scope 内だけ触れ」を同時に命じる）。
  grader は正しく scope 外編集を escalate（never-silent）——直すべきは grader でなく契約。**option A: sandbox の `scope.include` を `['src/**','test/**']` に拡張**
  （`test/acceptance/**` は protected 維持＝独立 grader は不可侵）。**grounded で収束を確認**: 再ループの 2 走行目で発火し、attempt 2 が
  `src/roman.ts`＋`test/roman.test.ts`（今度は in-scope）を書いて **functionality・testQuality とも approve → panel=approve で収束**（初の grounded 収束サイクル）。
  副次メモ: `scope_check` は `scope.exclude` を見ず `include`＋`protectedPaths` のみで判定（`grade.ts:103-108`）＝`scope.exclude` は grader 上は飾り（今回は害なし・別途 grader 仕様判断なら要検討）。

## 落とし穴・不変条件

- `.harness/` は **gitignore・ローカル揮発**（store・sandbox・worktrees・review-worktrees・evidence）。scaffolder で決定論再生成。store の issue/eval はローカルのみ（共有されない）。
- **grounded だけが暴くバグがある**（mock はプロンプトを出さない）。今回の2バグ（submit race・worktree 非冪等）が実例。substrate は self-verify させ、`monitorLiveness` を never-silent の最後の砦にする。
- **escalate over false-pass**（`ARCH-execution-015`）: 観点の出力欠落/不正は握り潰さず `needs-human-review` へ。6/7 approve でも1つ欠ければ escalate。
- **liveness surfacing**（`ARCH-execution-014`）: stuck セッションは kill/timeout せず生かす（`tmux attach` で人間が引き継ぐ）。
- **headless 非目標**: 実 agent は対話 tmux セッション（`claude -n`）。`claude -p` は使わない・`makeRunner` は mock 以外 throw。
- **オーケストレータは決定論**: poll/dispatch/grade/gate/store を LLM に委ねない。`agentops run`（coordinator）は mock demo 用の別経路（approve→自動 released）で execution 層の live 経路と混同しない。
- 環境: tmux 3.7・claude 2.1.x（既定モデル＝Opus 4.8。`config.models.{generator,reviewer}` で role 別に上書き可・未指定は既定継承）。generator worktree=`ao-issue-*-s*`、review=`ao-eval-issue-*-s*-<観点>`。
- **セッションはタブ**: 全ロールは holder セッション `agentops`（`AGENTOPS_TMUX_SESSION` で上書き可）の**ウィンドウ**として起きる。ライブ観察は `tmux attach -t agentops`（完了タブは自動で閉じ・stuck タブは残る）。tmux セッション名でなく**ウィンドウ名**が `ao-issue-*` / `ao-eval-*`。
