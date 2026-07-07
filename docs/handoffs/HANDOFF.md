# 完全引き継ぎ — AI 開発組織ハーネス（これ一枚で全コンテキスト）

> 別セッションで cold-start するための**自己完結**の引き継ぎ。作成: 2026-07-07。
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
| ③改善 | 🟡 決定論実装＋テスト済み・**loop 未閉** | Curator/Analyst 実装＋CLI 配線＋決定論テスト済み。欠け: **live 経路に未配線**・**実失敗→昇格→改善→計測の一巡が grounded 未観測**。＝①repair がセッション開始時にいた段階。 |

## 2. システム地図（層・実装・設計正本）

上流（人間が WHAT を著す）から下流（自律実行・評価・改善）へ:

- **planning / authoring / design（上流・著述）** — 署名 spec を著し、system 層（ドメイン/アーキ/データ/言語）と Issue へ分解。
  実装: `src/pipeline/contract-draft.ts`、skills `to-spec`/`to-system-design`/`to-detail-design`、設計正本 `docs/specs/_system/{authoring,design,planning}`。**本セッションでは未変更**（上流は既存）。
- **① execution（自律実行）** — ai-managed issue を実 Claude セッション（対話 tmux・`claude -n`、**headless 非目標**）で実装。
  実装: `src/pipeline/execution/`（`loop.ts` 制御・`live.ts` live 配線・`session.ts` generator・`perspective-session.ts` reviewer・`tmux.ts` 基質・`worktree.ts`・`grade.ts` 実採点・`gate.ts` ゲート・`scoped-context.ts` 設計注入）。正本: **ADR-0005** ＋ `docs/specs/_system/execution` 4ビュー。
- **② evaluation（評価）** — 実 tsc/vitest の hard-gate（ADR-0003）＋7観点パネル（functionality は決定論、他6観点は read-only Claude レビュー）。集約 Verdict→ human ゲート。
  実装: `src/pipeline/panel.ts`・`evaluate.ts`・`src/graders/`・`src/metrics/metrics.ts`。正本: **ADR-0006** ＋ `_system/evaluation`。
- **③ improvement（自己改善）** — `curator.ts`（失敗→回帰 EvalTask 昇格）＋`analyst.ts`（metrics→`type:harness`/`type:eval` 改善 issue 起票）。**改善は同じ roadmap の issue として同じ drive loop で回す**（＝ハーネスが自分を直す）。
- **オーケストレータは決定論**（ADR-0004・`DOM-execution-008`）: poll/dispatch/grade/gate/store を LLM に委ねない。`agentops run`（`coordinator.ts`）は**mock demo 用の別経路**（approve→自動 released）で、execution の **live 経路**（`runLoopLive`）と混同しない。

ADR 一覧: 0001 JSON store=SoT / 0002 Zod=published language / 0003 hard-gate-before-score / 0004 決定論＋pluggable backend / 0005 execution tmux / 0006 evaluator panel＋PR ゲート。

## 3. 現在地 — このセッションの全成果（全て `origin/main`）

出発点は「execution 層は実装・決定論テスト完了、残タスク＝repair loop の grounded 発火観測」。それを解消し、さらに機能追加・③着手まで進めた。

`git log --oneline`（新しい順）:

- `27e9b00` docs: handoff に③決定論テスト done を反映
- `43d73b7` **improvement: ③ self-improvement loop の決定論テスト**（Curator+Analyst・両輪＋ループ閉包）
- `4742526` docs: ③ frontier ハンドオフ作成（本 HANDOFF に統合済み）
- `8dd7f17` docs: repair 収束＋タブ機能を記録
- `d5badec` **execution: ロールセッションを holder tmux の window（タブ）化**（`tmux attach -t agentops` で観察）
- `b85b18f` **sandbox: 契約 scope を `test/**` へ拡張**（scope_check テンション修正）
- `71b446c` **docs: repair loop の grounded 発火観測（landmark）**
- `bac40ef` **execution: PromptRecord（発行プロンプトを store へ監査射影・`DATA-execution-006`）**
- `6238da4` docs: haiku 実験（当時 repair 不発）の記録
- `00df909` **execution: per-role モデル選択（`config.models` → `claude --model`）**

決定論: **`npm test` 198 green**＋`npm run typecheck`＋system-design check、すべてパス。

grounded で観測したこと（実 Claude 走行）:

- **repair 発火**: 弱 generator（haiku）× repair-bait × `MAX_REPAIRS=1` で attempt 1 の request_changes → 2-fix brief → attempt 2 発火。発火条件は「functionality の hard-fail」でなく **弱コーダ × 強い敵対的レビュアの dissent**（testQuality が**コードを実行して**非正準受理バグを発見）。
- **repair 収束**: scope 修正後、attempt 2 が `test/**` にテスト追加 → 全ゲート pass → panel=approve＝**初の grounded 収束サイクル**。
- **PromptRecord の実証**: 発火時、attempt 1/2 の発行本文（repair brief 込み）が store に durable 保全＝上書き・wipe される PROMPT.md では失われていたものが残る。
- **モデル上書きの実証**: generator pane=`Haiku 4.5`・review pane=`Opus 4.8` を確認。

## 4. frontier（次の一手）— ③改善ループを grounded で閉じる

**ゴール**: 実失敗 → Curator が回帰 EvalTask 昇格 → Analyst が harness 改善 issue 起票 → その issue を execution 層で駆動 → metrics（pass@k/pass^k・false-pass率）で改善確認、という一巡を **grounded で一度回して観測**する（execution repair と同じ流儀：機構は決定論で在る→実走で loop が閉じるのを見る）。

**最初の"種"はこのセッションの実失敗**（一級データ）:

- **scope_check テンション**: `testQuality` の brief が「テスト追加」を要求するのに契約 scope が `src/**` のみ、という**自己矛盾**（役割プロンプト `agents/generator.md` も両方を命じる）。修正済み（scope 拡張）だが**回帰 eval には未昇格**＝Curator/契約 lint の昇格候補。
- **grader 非決定性**: `testQuality` が同等コードで approve/request_changes に **~1/3 揺れる**。humanVerdict 較正データ＝Analyst が「stabilise」を提案すべき入力。

**具体ステップ案**:

1. Curator/Analyst を **live 経路（`runLoopLive` 後）へ配線するか、まず CLI（`agentops curate`/`analyze --create`）で手動一巡**するか判断（設計判断：頻度・いつ回すか。mock の `agentops run` と混同しない）。
2. ~~専用決定論テスト補強~~ **✅ 完了**（`test/improvement-loop.test.ts`・`43d73b7`）。
3. **grounded で一巡観測**: 失敗する panel run → curate で EvalTask 昇格 → analyze `--create` で harness issue → その issue を drive → metrics 前後比較。
4. 操舵指標の計器化: 「回帰化された失敗の率」「false-pass率の推移」を metrics/dashboard に出す。

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

# 改善ループ（既存 CLI 経路・cmdCurate/cmdAnalyze @ src/cli/index.ts）
#   curate:            失敗した blocker AC を回帰 EvalTask へ昇格
#   analyze --create:  metrics から type:harness/eval の改善 issue を起票

# ゲート（人間判断）: recordHumanDecision(store,'ISSUE-0001','approve'|'reject') を tsx で直呼び（CLI 未整備）
```

**ハーネスは手動 attach 方針**（ターミナル非依存）: `agentops` セッションは `home` タブで生き続けるので一度 attach して張り付けば以降の run のタブがそこに自動で現れる。自動ポップアップは iTerm2 の `tmux -CC` 専用で Ghostty 非対応のため採用しない。

## 6. 落とし穴・不変条件（層横断）

- **状態は store**（ADR-0001・北極星の反証「状態が tmux や人の頭にある」を踏まない）: 失敗・昇格・改善・発行プロンプトを全て EvalRun/EvalTask/Issue/PromptRecord に写す・resume/監査可能に。
- **never-silent**: セッションは静かに終わらせない。完了は sentinel（`.agentops/done.json`）でのみ確定、stuck は kill せず**生かしたまま** human へ昇格（`tmux attach`）＝`ARCH-execution-014`。
- **escalate over false-pass**（`ARCH-execution-015`）: 観点の出力欠落/不正は握り潰さず `needs-human-review`。6/7 approve でも1つ欠ければ escalate。
- **grounded だけが暴くバグがある**（mock はプロンプトを出さない）: 実例＝submit race・worktree 非冪等（修正済・決定論テスト付き）。
- **回帰化されない失敗は"改善が外れているサイン"**: 見つけた失敗を直すだけで終わらせず回帰 eval へ昇格する（③の心臓）。
- **決定論境界**: orchestrator（poll/dispatch/grade/gate/store）は決定論コード、非決定な実エージェントはセッション内（HOW 遂行）に閉じる。
- **副次 finding（未修正・害なし）**: `scope_check` は `scope.exclude` を見ず `include`＋`protectedPaths` のみで判定（`grade.ts:103-108`）＝`scope.exclude` は grader 上は飾り。

## 7. 環境・資源の住処

- 環境: tmux 3.7・claude 2.1.x（既定 Opus 4.8。`config.models.{generator,reviewer}` で role 別上書き可・未指定は既定継承）。
- **セッションはタブ**: 全ロールは holder `agentops`（`AGENTOPS_TMUX_SESSION` で上書き可）の**ウィンドウ**。ウィンドウ名 generator=`ao-issue-*-s*`・review=`ao-eval-issue-*-s*-<観点>`。
- `.harness/` は gitignore・ローカル揮発（store・sandbox・worktrees・review-worktrees・evidence）。scaffolder（`real-run-sandbox.ts`）で決定論再生成。store の issue/eval はローカルのみ。
- skill 著述規約: 正本 `SKILL.md`＋日本語訳 `SKILL.md.ja` 併設・frontmatter `description` は日本語・skill 外へ `../` で登らない・確定処理は `scripts/`（`src/` の vendored lib）へ委譲（詳細は `workflow/CLAUDE.md`）。

## 8. canonical（深掘り・必要時のみ）

- `docs/NORTH_STAR.md` — 三能力・操舵指標・反証サイン（最上位要求）。
- `docs/decisions/ADR-0005`（execution premises）・`ADR-0006`（パネル E1-E7・ゲート G1-G3、末尾の実装先 id 表が地図）。
- `docs/specs/_system/execution/`（ARCH/DOM/DATA/LANG-execution-NNN が実装契約）・同 `evaluation/`。
- 主要ソース: `src/pipeline/execution/{loop,live,session,perspective-session,tmux,grade,gate}.ts`・`src/pipeline/{panel,curator,analyst,repair}.ts`・`src/metrics/metrics.ts`・`src/domain/schema.ts`・`src/config.ts`。
- テスト: `test/{improvement-loop,repair-loop,live-repair,panel,build-commit,launch-command,config,prompt-record,send-prompt}.test.ts` ほか（計198）。
- [execution-layer.md](execution-layer.md) — execution 層の grounded 実験の詳細ログ（発火/収束の生データ・過去の不発記録）。**継続に必須ではない**深掘りアーカイブ。
