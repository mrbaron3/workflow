# 完全引き継ぎ — AI 開発組織ハーネス（これ一枚で全コンテキスト）

> 別セッションで cold-start するための**自己完結**の引き継ぎ。作成: 2026-07-07（同日2回更新: ③一巡セッション）。
> **これを読めば継続に必要な文脈が揃う**。より深い execution 層の grounded 記録が要るときだけ
> [execution-layer.md](execution-layer.md)（任意アーカイブ）を見る。全成果は `origin/main` に push 済み・作業ツリー clean。

---

## 0. これは何か（30秒）

**AI 組織運用ハーネス**。狙いは「人間は**何を・なぜ（WHAT）**だけを述べ、それが**証拠付きで確実に動くソフトウェア**になる」。
人間の関与は判断点（WHAT 確定・承認・**審査＝release ゲート**）に限る。エージェント群が **HOW を自律遂行**し、
その過程と成果が**証拠で評価**され、その評価から**ハーネス自身が改善**する。

住処（正本の地図）:

- **仕様下書き** `draft/_spec/`（正式 spec は `to-spec` skill で生成）。
- **設計正本** `docs/specs/_system/`（境界コンテキスト別 4ビュー）＋ `docs/decisions/`（ADR）。
- **共有 deterministic ライブラリ** `src/`（fingerprint / lint / resolve / pipeline 等）。
- **Agent Skill** `.claude/skills/`（`to-spec`・`to-system-design`・`to-detail-design`）。
- **状態＝ SoT** は `.harness/db.json`（Zod schema `src/domain/schema.ts` が単一正本・ADR-0001/0002）。`.harness/` は gitignore・ローカル揮発。

## 1. 北極星（最上位要求 = `docs/NORTH_STAR.md`）

**「エージェント群が自律的に開発を行え、その開発プロセスを評価し、改善できる」** ＝ 次の三能力:

1. **自律開発** — 人間が HOW を与えずともエージェントが実装まで遂行。
2. **評価可能** — 過程と成果を証拠（AC / scorecard / evidence）で評価。
3. **改善可能** — 評価から、プロセス自体（grader / prompt / skill / routing / 新エージェント）が改善。

最優先の操舵指標: **「同じ種類の失敗を二度繰り返さない」**（失敗は必ず回帰評価ケースへ捕捉）。
明示的な非目標: 「自律」は HOW の自律であって WHAT/承認/審査の自律ではない・評価なき自律や headless 運用は範囲外。

### スコアカード（現在地・正直な採点）

| 能力 | 状態 | 根拠 / 欠け |
|---|---|---|
| ①自律 | 🟢 中核 grounded | issue を人間が HOW に触れず 実装→採点→パネル→ゲート→release まで駆動。**repair loop は発火も収束も実走観測済み**（このセッション）。欠け: 1 issue・1 課題クラス規模、上流一気通貫は未実証。 |
| ②評価 | 🟢 良好 | 実 tsc/vitest＝証拠採点・7観点パネル・escalate-over-false-pass・humanVerdict 較正・PromptRecord 監査。欠け: false-pass率↓は humanVerdict 蓄積待ち（数点）。 |
| ③改善 | 🟢 **一巡完結＋回帰実行者 grounded** | ADR-0007 で配線を確定し全て決定論実装＋テスト。**実失敗→自動 curate→analyze --create→adopt→self-hosted drive→panel approve→人間ゲート approve→released→恒久回帰化 の一巡を grounded で完走**（ISSUE-0003＝scope.exclude 修正・`904d511`）。一巡の途中で計器自身のバグを grounded が暴き修正（`8ed3e52`）＝③が③を直した。**回帰 registry の実行者も実装・grounded 済**（`ba5da28`・`agentops regress`＝ISSUE-0003 の2 task が各3 assertion 突合で pass・sandbox 束縛分は正直に skip）。計器ペア: capture 100%×executed 50%。残る欠け: unverified/束縛外 task の解消運用・Analyst 提案の粒度。 |

## 2. システム地図（層・実装・設計正本）

上流（人間が WHAT を著す）から下流（自律実行・評価・改善）へ:

- **planning / authoring / design（上流・著述）** — 署名 spec を著し、system 層（ドメイン/アーキ/データ/言語）と Issue へ分解。
  実装: `src/pipeline/contract-draft.ts`、skills `to-spec`/`to-system-design`/`to-detail-design`、設計正本 `docs/specs/_system/{authoring,design,planning}`。**本セッションでは未変更**（上流は既存）。
- **① execution（自律実行）** — ai-managed issue を実 Claude セッション（対話 tmux・`claude -n`、**headless 非目標**）で実装。
  実装: `src/pipeline/execution/`（`loop.ts` 制御・`live.ts` live 配線・`session.ts` generator・`perspective-session.ts` reviewer・`tmux.ts` 基質・`worktree.ts`・`grade.ts` 実採点・`gate.ts` ゲート・`scoped-context.ts` 設計注入）。正本: **ADR-0005** ＋ `docs/specs/_system/execution` 4ビュー。
- **② evaluation（評価）** — 実 tsc/vitest の hard-gate（ADR-0003）＋7観点パネル（functionality は決定論、他6観点は read-only Claude レビュー）。集約 Verdict→ human ゲート。
  実装: `src/pipeline/panel.ts`・`evaluate.ts`・`src/graders/`・`src/metrics/metrics.ts`。正本: **ADR-0006** ＋ `_system/evaluation`。
- **③ improvement（自己改善）** — `curator.ts`（失敗→回帰 EvalTask 昇格）＋`analyst.ts`（metrics→`type:harness`/`type:eval` 改善 issue 起票）＋`adopt.ts`（提案→人間 WHAT 確定→drive 可能化）＋`improve.ts`（live turn 末尾の常設 tail）。**改善は同じ roadmap の issue として同じ drive loop で回す**（＝ハーネスが自分を直す）。正本: **ADR-0007**。self-hosting は `config.target.repo='.'`＋env-gate 受け入れテスト（`test/acceptance-harness/`・protectedPaths 保護）。
- **オーケストレータは決定論**（ADR-0004・`DOM-execution-008`）: poll/dispatch/grade/gate/store を LLM に委ねない。`agentops run`（`coordinator.ts`）は**mock demo 用の別経路**（approve→自動 released）で、execution の **live 経路**（`runLoopLive`）と混同しない。

ADR 一覧: 0001 JSON store=SoT / 0002 Zod=published language / 0003 hard-gate-before-score / 0004 決定論＋pluggable backend / 0005 execution tmux / 0006 evaluator panel＋PR ゲート / **0007 ③改善ループの配線（adopt=人間WHAT・curate常設・self-hosting env-gate）**。

## 3. 現在地 — このセッションの全成果（③一巡・全て `origin/main`）

出発点は「③は決定論実装＋テスト済みだが loop 未閉（live 未配線・grounded 未観測）」。ADR-0007 で配線を
確定し、断線2つ（Analyst 起票 issue の drive 不能・self-hosting 経路欠如）を繋ぎ、**grounded 一巡を観測**した。

`git log --oneline`（新しい順・このセッション分）:

- （追記）**TDD の三層強制** — ①generator 役割プロンプトに TDD プロトコル義務化（red→green・AC-id タグ規約・テスト弱体化禁止）②testQuality lens（独立レビュア）に妥当性 rubric（壊れたら fail するか・同語反復検出・タグ検査・実走許可）③決定論ゲート: report が在るのに AC-id タグ付き assertion ゼロの unit_test AC は **unsatisfied**（従来は suite-green へフォールバック＝沈黙 pass の穴を閉鎖・`satisfiedFromReport` に抽出）
- `ba5da28` **improvement: 回帰 registry の実行者**（`runRegressionTasks`・`RegressionRun`・`agentops regress`・executedRate 計器・EvalTask.target 束縛）
- `8ed3e52` **fix(metrics): captureRate は AC severity で判定（Curator 意味論に一致）＋NUL 混入除去** — grounded が暴いた計器バグ
- `0306f44` **improvement: self-hosting 基盤**（env-gate 受け入れテスト・種 contract・`real-run-self.ts`・grader コマンドの `KEY=VAL` env プレフィックス）
- `4f75fe7` **improvement: runLoopLive 末尾に improveTick 常設**（curate 冪等・analyst report-only）
- `6a8760c` **improvement: 操舵計器 regressionCaptureRate・falsePassTrend**（status/dashboard 表示）
- `5b0a70b` **improvement: agentops adopt/decide/status --json**（提案→人間 WHAT→drive の遷移＋gate CLI）
- `0d6b5ac` **docs: ADR-0007 ③改善ループの配線**

決定論: **`npm test` 211 green＋2 skipped**（skip は env-gate 受け入れテスト＝設計どおり）＋typecheck パス。
TDD で追加（ユーザー指示）: adopt 3・計器 5・improveTick 2・grade-env 3。

grounded で観測したこと（③一巡・実 Claude 走行）:

- **失敗生成**: haiku×HARD×repairs0 → 受け入れは全パスしたが **testQuality が AC-3(major)/AC-2(minor) findings で dissent** → needs-human-review。前セッションと同型の「弱コーダ×敵対的レビュア」失敗クラス。
- **③自動発火（初観測）**: runLoopLive 末尾の improveTick が Curator を自動実行 → AC-2 が `[regression]` 昇格・Analyst 提案4件を report-only 出力。
- **計器の自己修正**: captureRate が null を報告 → 原因は「finding severity で分母を絞る」実装と「AC severity で判定する」Curator の意味論不一致。**grounded でしか出ない失敗形**（blocker AC への minor finding）。TDD で修正（`8ed3e52`）。ついでに区切り文字への U+0000 リテラル混入も発見・除去。
- **提案→adopt→self-hosted drive**: `analyze --create` で ISSUE-0002〜0004 起票 → ISSUE-0003 を種 contract（scope.exclude 修正）で adopt → **ハーネス自身の worktree で実 Claude が `grade.ts` を修正＋5テスト追加 → 独立検証 218/218 green（受け入れ2件が skip→実走 green 化）→ panel 3観点全 approve → gate 停止**。attempt 1 収束。
- **metrics 前後**: passAt1 0→0.5・falsePassRate 0%（labels 2件・grader agreement 100%）・captureRate 100%・registry 0→4。before スナップショット `.harness/metrics-before.json`（`status --json`）。
- **正直な注記**: (a) EVAL-00001/2 の humanVerdict ラベルは operator（Claude）が決定論的証拠に基づき付与 — 人間の再ラベルで上書き可。(b) adopt した ISSUE-0003 のタイトルは Analyst のテンプレ提案（pass@1 改善）で、contract の中身（scope.exclude 修正）への尖らせは人間判断の WHAT 確定として行った（ADR-0007 I1 の設計どおりだが、提案とcontract の意味的距離は残る＝Analyst 提案の粒度改善は将来課題）。

前セッションまでの成果（repair loop 発火/収束・PromptRecord・タブ化・モデル上書き等）は §6 の不変条件と
[execution-layer.md](execution-layer.md) に吸収済み。

## 4. frontier（次の一手）— 回帰 registry の実行

**このセッションで締結済み**（一巡完走）: ISSUE-0003 を human gate approve → build（`grade.ts` 修正＋
5 テスト）を main へ cherry-pick（`904d511`）→ 受け入れグレーダを恒久回帰ガードへ昇格（skipIf 除去・
protectedPaths 内に残置で tamper-proof）→ before/after 比較（passAt1 0→0.5・released 0→1）→ worktree/branch 掃除。
before/after スナップショットは `.harness/metrics-{before,after}.json`（ローカル揮発）。
sandbox の ISSUE-0001（roman bait）は needs-human-review のまま＝実験残骸（.harness 揮発なので害なし）。

**締結済み（同日追記）**: **回帰 registry の実行者を実装・grounded 実走済み**（`ba5da28`）。
`runRegressionTasks`＝target の unit_tests grader を1回実走し assertion 名×AC-id 突合で
pass/fail/unverified 判定。EvalTask は curate 時に `target`（repo）へ**束縛**（registry は複数 target 混在・
AC-id は issue 間衝突するため。null=legacy は skip＋報告）。結果は `RegressionRun`（EvalRun と別置き＝
pass@k の分母を汚染しない）。improveTick が live turn 末尾で常設実行。計器 `regressionExecutedRate` が
captureRate の隣に並ぶ（grounded 実測: capture 100%×executed 50%・ISSUE-0003 の2 task pass・
sandbox 束縛の2 task は skip 報告）。

**次の frontier 候補（優先順）**:

- **Analyst 提案の粒度改善**: テンプレ提案（pass@1 低い等）と adopt される contract の意味的距離が grounded で
  可視化された（§3 正直な注記 b）。失敗クラス（scope テンション・grader 揺れ）から**具体的な** issue 文面を
  生成する決定論ルールを増やす。ISSUE-0002（pass^k stabilise）/ISSUE-0004（repair brief 改善）が planned のまま
  在庫＝次の adopt 候補。
- **grader 非決定性の較正継続**: testQuality の揺れ（前セッション ~1/3）。labels を蓄積し falsePassTrend で監視。
- **上流一気通貫**: roadmap→spec→sign→spawn→drive を1本通す（上流は未変更のまま）。
- **回帰実行の運用磨き**: unverified（AC-id を運ぶ assertion が無い task）への tag 付け運用・playwright 等
  unit_test 以外の grader 対応・sandbox など別 target への実行切替。

## 5. 動かし方（コマンド）

```bash
# 決定論の確認（198 green）
npm test && npm run typecheck
npx tsx .claude/skills/to-system-design/scripts/check-system-design.ts .harness/sysdesign-execution --system docs/specs/_system

# grounded execution（cost・claude 認証が要る）
npx tsx scripts/real-run-sandbox.ts                    # 使い捨て sandbox＋ai-managed ISSUE-0001（roman）
LENSES=testQuality npx tsx scripts/real-panel-run.ts   # 安く1観点（LENSES 無指定で全6観点）
GEN_MODEL=haiku HARD=1 MAX_REPAIRS=1 \
  npx tsx scripts/real-run-sandbox.ts                  # repair 発火狙い（弱コーダ×bait×repair 許可）
tmux attach -t agentops                                # ライブ観察（各ロールがタブ・完了で自動クローズ・stuck は残る）

# 改善ループ③（live turn 末尾で curate/regress/analyst-report は自動。手動 CLI:）
npm run harness -- curate                    # 失敗した blocker AC → 回帰 EvalTask（冪等・target 束縛）
npm run harness -- regress                   # 束縛済み registry を実 grader で再検証（pass/FAIL/unverified）
npm run harness -- analyze --create          # metrics → type:harness/eval issue 起票（人間判断）
npm run harness -- adopt ISSUE-NNNN --contract scripts/seeds/scope-exclude.contract.yaml
                                             # 提案の WHAT を確定 → contract-drafted（drive 可能に）
npx tsx scripts/real-run-self.ts             # target をこのリポジトリ自身へ（store は wipe しない）
npm run harness -- decide ISSUE-NNNN approve # 人間ゲート（approve→released＋humanVerdict 収穫）
npm run harness -- status --json             # 機械可読スナップショット（改善 before/after 比較）
npm run harness -- label --run EVAL-NNNNN --human approve|request_changes  # 較正ラベル
```

**ハーネスは手動 attach 方針**（ターミナル非依存）: `agentops` セッションは `home` タブで生き続けるので一度 attach して張り付けば以降の run のタブがそこに自動で現れる。自動ポップアップは iTerm2 の `tmux -CC` 専用で Ghostty 非対応のため採用しない。

## 6. 落とし穴・不変条件（層横断）

- **状態は store**（ADR-0001・北極星の反証「状態が tmux や人の頭にある」を踏まない）: 失敗・昇格・改善・発行プロンプトを全て EvalRun/EvalTask/Issue/PromptRecord に写す・resume/監査可能に。
- **never-silent**: セッションは静かに終わらせない。完了は sentinel（`.agentops/done.json`）でのみ確定、stuck は kill せず**生かしたまま** human へ昇格（`tmux attach`）＝`ARCH-execution-014`。
- **escalate over false-pass**（`ARCH-execution-015`）: 観点の出力欠落/不正は握り潰さず `needs-human-review`。6/7 approve でも1つ欠ければ escalate。
- **grounded だけが暴くバグがある**（mock はプロンプトを出さない）: 実例＝submit race・worktree 非冪等（修正済・決定論テスト付き）。
- **回帰化されない失敗は"改善が外れているサイン"**: 見つけた失敗を直すだけで終わらせず回帰 eval へ昇格する（③の心臓）。
- **決定論境界**: orchestrator（poll/dispatch/grade/gate/store）は決定論コード、非決定な実エージェントはセッション内（HOW 遂行）に閉じる。
- **TDD は三層で強制**: 役割プロンプト（generator の red→green 義務・AC-id タグ規約）×独立レビュア（testQuality lens の妥当性 rubric）×決定論ゲート（タグ無し unit_test AC は unsatisfied・`satisfiedFromReport`）。タグ規約は grading と回帰実行（`agentops regress`）の両方が突合に依存する基盤規約。
- **副次 finding（未修正・害なし）**: `scope_check` は `scope.exclude` を見ず `include`＋`protectedPaths` のみで判定（`grade.ts:103-108`）＝`scope.exclude` は grader 上は飾り。

## 7. 環境・資源の住処

- 環境: tmux 3.7・claude 2.1.x（既定 Opus 4.8。`config.models.{generator,reviewer}` で role 別上書き可・未指定は既定継承）。
- **セッションはタブ**: 全ロールは holder `agentops`（`AGENTOPS_TMUX_SESSION` で上書き可）の**ウィンドウ**。ウィンドウ名 generator=`ao-issue-*-s*`・review=`ao-eval-issue-*-s*-<観点>`。
- `.harness/` は gitignore・ローカル揮発（store・sandbox・worktrees・review-worktrees・evidence）。scaffolder（`real-run-sandbox.ts`）で決定論再生成。store の issue/eval はローカルのみ。
- skill 著述規約: 正本 `SKILL.md`＋日本語訳 `SKILL.md.ja` 併設・frontmatter `description` は日本語・skill 外へ `../` で登らない・確定処理は `scripts/`（`src/` の vendored lib）へ委譲（詳細は `workflow/CLAUDE.md`）。

## 8. canonical（深掘り・必要時のみ）

- `docs/NORTH_STAR.md` — 三能力・操舵指標・反証サイン（最上位要求）。
- `docs/decisions/ADR-0005`（execution premises）・`ADR-0006`（パネル E1-E7・ゲート G1-G3、末尾の実装先 id 表が地図）・`ADR-0007`（③配線 I1-I4・未吸収＝ビュー吸収が残タスク）。
- `docs/specs/_system/execution/`（ARCH/DOM/DATA/LANG-execution-NNN が実装契約）・同 `evaluation/`。
- 主要ソース: `src/pipeline/execution/{loop,live,session,perspective-session,tmux,grade,gate}.ts`・`src/pipeline/{panel,curator,analyst,adopt,improve,repair}.ts`・`src/metrics/metrics.ts`・`src/domain/schema.ts`・`src/config.ts`。
- テスト: `test/{improvement-loop,adopt,metrics,grade-env,repair-loop,live-repair,panel,build-commit,prompt-record}.test.ts` ほか（計 211＋skip 2）。`test/acceptance-harness/` は env-gate（`ACCEPT_HARNESS=1` でのみ収集）。
- [execution-layer.md](execution-layer.md) — execution 層の grounded 実験の詳細ログ（発火/収束の生データ・過去の不発記録）。**継続に必須ではない**深掘りアーカイブ。
