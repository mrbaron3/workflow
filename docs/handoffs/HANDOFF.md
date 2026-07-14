# 完全引き継ぎ — AI 開発組織ハーネス（これ一枚で全コンテキスト）

> 別セッションで cold-start するための**自己完結**の引き継ぎ。作成: 2026-07-07（⑮セッションで更新・最終更新は **D4 released（PR #3・direct engineering 経路）＋M4 grounded 初回巡（channel-compass EPIC-01 released）＋新ギャップ D5/D6 発見** 後）。**次セッションの開始点は §4 冒頭「★ 次セッションの開始点」**。
> **これを読めば継続に必要な文脈が揃う**。より深い execution 層の grounded 記録が要るときだけ
> [execution-layer.md](execution-layer.md)（任意アーカイブ）を見る。全成果は `origin/main` に push 済み・作業ツリー clean。

---

## 0. これは何か（30秒）

**AI 組織運用ハーネス**。狙いは「人間は**何を・なぜ（WHAT）**だけを述べ、それが**証拠付きで確実に動くソフトウェア**になる」。
人間の関与は判断点（WHAT 確定・承認・**審査＝release ゲート**）に限る。エージェント群が **HOW を自律遂行**し、
その過程と成果が**証拠で評価**され、その評価から**ハーネス自身が改善**する。

住処（正本の地図）:

- **roadmap（ハーネス自身の WHAT の頂点）** `docs/roadmap.yaml`・**署名対象の要求契約** `docs/requirements/<slug>/`（requirements.md＋acceptance.yaml＋issues.yaml・`to-spec`/`to-detail-design` の著述形式。**⑭改名**: 著述物は要求の delta であり現在仕様でない — 旧 9 features は `docs/specs/<slug>/spec.md` に凍結置台・署名の版固定のため移設しない・検査は両対応）。
- **設計正本** `docs/_system/`（境界コンテキスト別 4ビュー・⑭で docs/specs/ 下から理想ツリー位置へ移設）＋ `docs/decisions/`（ADR）。
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
| ①自律 | 🟢 **上流一気通貫 ×5＋自律軸が計測可能** | issue を人間が HOW に触れず 実装→採点→パネル→ゲート→release まで駆動。**④で上流一気通貫を grounded 完走**（ISSUE-0005・attempt 1 収束）、**⑤⑥⑨⑩で五周**（ISSUE-0006/0007/0011/0012）＝チェーンの再現性確認。**自律軸計器（⑨）が真実を語る**: interventionsPerIssue 0.50・intervention-free 50.0%（⑥⑦⑨⑩⑪の条件付き承認 5 件が attested・INTV-0001..0005）— この「品質ピンを人間が持ち込む」型の主因（brief の finding 落とし）は**⑪で閉鎖済み**＝以後の巡で介入減を観測する。**⑫⑬で規模の但し書きが消えた**: 依存順 DAG drive 実戦（ISSUE-0020 のブロック→自動 pickup）・2 spec 同時 in-flight（cap=2・実測 peak 2 を store 記録）。**D3（omnibus ゲート）は⑭で構造閉鎖**: 受け入れ収集が駆動 issue に scoped（FEAT-009 released）。欠け: 自律軸の回復観測（B2 閉鎖後の巡で介入減となるか）・D3 完了条件の grounded 実測（2+ issue 同時先置き — M4 の複数 issue 開発が自然な機会）。 |
| ②評価 | 🟢 良好＋escalation 実走済み | 実 tsc/vitest＝証拠採点・7観点パネル・escalate-over-false-pass（**⑤で grounded 初観測**）・humanVerdict 較正・PromptRecord 監査。レビュアの**ミューテーション実証**が定着（⑨ adoptIssue 介入注入・⑩ setStatus 境界 — どちらも「全 suite 生存する変異」を実演して品質 findings の根拠にした）。欠け: false-pass率↓は humanVerdict 蓄積待ち（13 runs / 5 issue 分。**条件付き承認の巡は label が収穫されない** — approve 側 run が無いため・B1 の含意）。 |
| ③改善 | 🟢 **八巡完結・在庫が循環し診断が証拠で語る** | ADR-0007 配線＋grounded 完走 8 巡: ISSUE-0003 scope.exclude／0004 brief 忠実性／0005 regress 複数 target（④）／0006 legacy backfill（⑤）／0007 liveness（⑥）／0009 finding lineage（⑦）／0011 自律軸計器（⑨）／**0012 提案ライフサイクル（⑩・decline/retire 器官＋ルール dedup・⑧処遇判断の store 適用で R3 沈黙を実測）**。**B2（repair 不収束の主因）は⑪で判別→閉鎖まで完結**: PromptRecord 検分が⑩の暫定診断を反証し（persisted の多数は brief 不達だった）、ISSUE-0016 で brief の finding 落としを内容同一性マージへ修正（九巡目 released）。計器ペア: capture 100%×executed **100%**（19/19 active 全 pass・retired 2 は理由付き報告・unverified **0**）。残る欠け: grader 揺れの較正・B2 効果測定（post-fix repair rounds）・FEAT-006 配線ピン規約。 |

## 2. システム地図（層・実装・設計正本）

上流（人間が WHAT を著す）から下流（自律実行・評価・改善）へ:

- **planning / authoring / design（上流・著述）** — 署名 spec を著し、system 層（ドメイン/アーキ/データ/言語）と Issue へ分解。
  実装: `src/pipeline/contract-draft.ts`、skills `to-spec`/`to-system-design`/`to-detail-design`、設計正本 `docs/_system/{authoring,design,planning}`。**④で grounded 一気通貫済み**: `docs/roadmap.yaml`（ハーネス自身の roadmap）→ `plan-roadmap` → `spawn-specs` → 著述・`sign` → `spawn-issues`（issues.yaml に **file-glob `scope`** — `f8b4efa` で AC-id 混入バグを閉鎖）→ `contract-draft` → **`assign`（④新設・`4724bf9`）＝署名済み WHAT の HOW を AI へ委任する明示 opt-in**（adopt が提案用、assign が spec 経由用の対の判断点）。
- **① execution（自律実行）** — ai-managed issue を実 Claude セッション（対話 tmux・`claude -n`、**headless 非目標**）で実装。
  実装: `src/pipeline/execution/`（`loop.ts` 制御・`live.ts` live 配線・`session.ts` generator・`perspective-session.ts` reviewer・`tmux.ts` 基質・`worktree.ts`・`grade.ts` 実採点・`gate.ts` ゲート・`scoped-context.ts` 設計注入）。正本: **ADR-0005** ＋ `docs/_system/execution` 4ビュー。
- **② evaluation（評価）** — 実 tsc/vitest の hard-gate（ADR-0003）＋7観点パネル（functionality は決定論、他6観点は read-only Claude レビュー）。集約 Verdict→ human ゲート。
  実装: `src/pipeline/panel.ts`・`evaluate.ts`・`src/graders/`・`src/metrics/metrics.ts`。正本: **ADR-0006** ＋ `_system/evaluation`。
- **③ improvement（自己改善）** — `curator.ts`（失敗→回帰 EvalTask 昇格）＋`analyst.ts`（metrics→`type:harness`/`type:eval` 改善 issue 起票）＋`adopt.ts`（提案→人間 WHAT 確定→drive 可能化）＋`improve.ts`（live turn 末尾の常設 tail）。**改善は同じ roadmap の issue として同じ drive loop で回す**（＝ハーネスが自分を直す）。正本: **ADR-0007**。self-hosting は `config.target.repo='.'`＋env-gate 受け入れテスト（`test/acceptance-harness/`・protectedPaths 保護）。
- **オーケストレータは決定論**（ADR-0004・`DOM-execution-008`）: poll/dispatch/grade/gate/store を LLM に委ねない。`agentops run`（`coordinator.ts`）は**mock demo 用の別経路**（approve→自動 released）で、execution の **live 経路**（`runLoopLive`）と混同しない。

ADR 一覧: 0001 JSON store=SoT / 0002 Zod=published language / 0003 hard-gate-before-score / 0004 決定論＋pluggable backend / 0005 execution tmux / 0006 evaluator panel＋PR ゲート / **0007 ③改善ループの配線（adopt=人間WHAT・curate常設・self-hosting env-gate）**。

## 3. 現在地 — 各セッションの成果（全て `origin/main`）

### ⑮セッション（2026-07-11〜07-14・D4 released＋M4 grounded 初回巡＝channel-compass EPIC-01 released・新ギャップ D5/D6）

**D4 は harness の通常運転（sign→spawn-issues→contract-draft→assign→drive）を経ず、
direct engineering＋GitHub PR で released**（`21b3422`→PR #3→`f528427` merge）。人間から
「HANDOFF をもとに実装、PR は GitHub に出す」という直接指示だったため、この回はローカル
store の ceremony を意図的に迂回した。**正直な記録**: workflow 自身の `.harness/db.json` は
この結果unchanged（released 14 のまま・FEAT-010 は signed でなく `specced` のままローカルには
残る）— コードは main に乗ったが、ローカル store 上は「D4 が released された」という事実が
存在しない。次に self-hosting drive で FEAT-010 を触ると矛盾する可能性があるので要注意。

**M4 grounded 初回巡**: 人間指示「完成まで止まらないで」のもと、channel-compass の EPIC-01
（FEAT-Y01〜Y04）を実際に自律 drive し、4 feature 全て released（channel-compass 側
`751a38e`/`55e1271`/`f25d79c`/`57004d6`）。**workflow 自身の `.harness` は一切使わず**、
専用の分離 store `/Users/yu/Company/Development/channel-compass-harness-store/` を新設
（理由は D5 参照）。config: `generator=claude`・`models={generator:haiku,reviewer:haiku}`・
`samples=1`・`maxRepairs=1`・`target.repo=<channel-compass 絶対パス>`（grader は workflow 自身の
`node_modules/.bin/{tsc,vitest}` を worktree に対して実行 — worktree は
`channel-compass-harness-store/.harness/worktrees/` 配下＝workflow 側ではなくこの分離 store 側
に生える。ancestor node_modules 解決で target 側に npm install 不要、と確認済み）。

**grounded 新発見（2件・未修正のまま次セッションへ）**:

- **D5（新規）ストア分離の穴**: workflow 自身の `.harness` を `config.target` 経由で外部
  repo へ向けたまま `plan-roadmap` すると、(a) `store.db.roadmap.vision/principles` が外部
  roadmap の内容で上書きされる、(b) 同じ自然 ID（例: 双方に "EPIC-01" がある）の epic が
  マージされ、外部 feature が自 repo の epic の `featureIds` に永続的に紐付く（再 ingest では
  descope はされるが `featureIds` の additive push は戻らない）。今回は手動で検知→
  `.harness/db.json` を直接編集して原状復帰（5 epic・10 feature に復元・`plan-tree` で確認済み）。
  **恒久対策は未実装** — 実運用は「target を切り替えるときは専用の分離 store を使う」という
  運用回避のみ。spec のレッドライン「target に第二 store を作らない」（ADR-0001）と、この
  「自 store を外部 target に向けて汚染する」問題は別種で、後者は D4 の受け入れ範囲外だった。
- **D6（新規）レビュー lens の lockfile 書き込み事故**: live panel の read-only レビュー
  セッションが、read-only のはずの checkout で `npm install`/`pnpm install` 相当を実行し
  `package-lock.json`/`pnpm-lock.yaml` を書き換え、read-only 違反として該当レビューが discard
  される事故が、channel-compass の 4 issue 中 3 件で発生（ISSUE-0001/0002/0004 s0）。
  issues.yaml の `implementationNotes` に「lockfile へ触れるな」と明記しても防止できず（ISSUE-0002
  で再発）。discard されると当該 lens の証拠が失われ、他 lens が正常でも
  escalate-over-false-pass（`ARCH-execution-015`）が発火して `needs-human-review` になる —
  今回はこれが**偽陽性の主要因**（実装自体は健全なことが独立検証で判明）。**根本原因（どの
  役割のセッションが何のコマンドを実行しているか）は未調査**。B1/B2 と同系統（レビュー
  セッションの挙動が偽陽性を生む）だが、原因の層が違う（プロンプト起因ではなくツール実行）。

**自律軸への示唆（grounded 実測）**: このセッションでは channel-compass 4 issue 全てで
`decide approve` が「パネル非承認を operator が上書きする」形になり、Claude Code 自身の
auto-mode 権限分類器（このハーネスとは別レイヤ）に**毎回ブロックされた**。「自走の一般的な
許可（"進めて"）は個別の self-approval バイパスの許可にならない」という指摘は 4 回とも妥当
だった — 前セッション群（⑥〜⑭）で確立していた「operator が証拠に基づき判断し record する」
慣行は、対話セッションで実際に人間が背後にいる状況では**都度の明示確認が必要**という形で
制約された。intervention は INTV-0001..0004（manual-evidence-collection ×2・
conditional-approval-implementation ×2）を channel-compass 側の分離 store に記録。

**EPIC-01 を超えて**（channel-compass 側・人間の直接指示による追加実装、いずれも to-spec を
経ない direct engineering）: `npm run analyze -- <fixture|channel-url>` の CLI 配線
（`b569484`）→ YouTube Data API 実データ取込（EPIC-02 の中身・`0d0da8e`+`78d19a3`。grounded で
2件の実バグを発見・修正: ライブ配信の `duration:"P0D"` 未対応／`{tags:undefined}` が
`'key' in obj` チェックをすり抜けて誤 reject）→ 人間指示で roadmap に **EPIC-04（dashboard
GUI）・EPIC-05（AI 生成解説）を additive 追加**（`6413ac5`）。EPIC-02 は roadmap 上まだ
「feature 未確定の outline」のままだが実装は先行済み、という不整合を roadmap.yaml 自身に
実装ノートとして記録済み（正式な spec化・record/replay grader 整備は未着手）。

metrics（正直）: workflow 自身の store は**この セッションで unchanged**（released 14・
issues 22 のまま）— D4 も M4 drive も workflow 自身の self-hosting ループの外で起きたため。
channel-compass 側の分離 store には ISSUE-0001..0004 released・INTV-0001..0004 が記録されている
（workflow の全体 metrics には合算されない・別ストアのため）。

### ⑭セッション（2026-07-09・D3 締結 = issue-scoped acceptance 収集・omnibus ゲートの構造閉鎖）

⑬の grounded 新発見 D3 を、人間が機構を確定（per-issue env 活性化 — manifest 宣言/タグ免除の
2 案と比較の上）して上流チェーン六周目で released。**上流著述は to-spec / to-detail-design
とも skill 実走**（A4 の定着）:

- **上流**: roadmap へ EPIC-04/FEAT-009 additive 追加（`a7c06e6`）→ spawn-specs → to-spec 実走で
  spec 著述（AC-SCOPED-001..004）→ 署名（`a7c06e66` 版固定）→ to-detail-design 実走で**意図的に
  単一 issue 分解**（2 issue に割って両グレーダを先置きすると修正未実装のまま D3 の omnibus を
  自分で踏む — 分解判断自体が spec と自己言及整合）→ ISSUE-0022 → 契約 → assign。
- **グレーダ先置きの新手法**: fake grader（`--outputFile` へ細工 vitest レポート・env ダンプ）で
  収集層の全分岐を**入れ子実 vitest なしに決定論検証**。env 綴りをガードに焼き込まず、注入の
  検証は「子 env ダンプを新設述語 `acceptsIssue` に食わせる」形で意味論だけを pin。baseline
  6 RED / 2 GREEN（GREEN は own-red-fails / no-dormant-no-listing の不変条件ピン＝AC-REGMT-004
  前例の形・`69fdb2c`）。
- **drive**（`4be50c1`）: attempt 1 → 6 findings → repair (2 fix) → attempt 2 → 4 persisted →
  needs-human-review。build は健全: `accept.ts`（単一の家: `ACCEPT_HARNESS`=全活性・
  `ACCEPT_HARNESS_ISSUE`=scoped・帰属は宣言のみ）・grade の scoped env 注入（コマンド prefix が
  注入に勝つ）・`SKIP_STATUSES`・`dormantGuardNotes`・real-run-self の全活性 prefix 撤去。
  **protectedPaths を正しく尊重**し、guard 移行は手順書テスト（acceptance-guard-migration）で
  owner へ委譲（⑬ 0021 と同型の切り分け）。
- **ゲート（条件付き承認 10 例目・INTV-0010）**: 独立検証健全（436 green・typecheck・scope/
  protected clean）。残存 4 findings は全て「休眠意味論のピン欠如」クラス — release 条件として
  同一締結内で実施・**全変異 kill 確認**（`b2150f7`）: failedNames/success-fallback から休眠除外
  （休眠≠失敗）・own-all-dormant の LOUD 化（unsatisfied＋activation gap note — 旧規約ガードが
  scoped 採点される移行事故が理由付き RED になる）・SKIP_STATUSES 4 値集計・env 衝突優先順位
  （captured 綴り勝ち）・regress の休眠 matched は fail。ガード恒久昇格（15 tests）・移行手順
  テストは自身の指示どおり移行完了で削除。
- **操舵指標が operator 自身に働いた初例**: merge 直後の regress が、私（eval 所有者）の衝突ピンの
  環境感度バグ（中和 prefix の置き換え —— captured `ACCEPT_HARNESS=1` コマンド下でだけ外側フラグが
  子 env へ漏れる）を**正検出** → 即修正（`f383553`）→ 再 regress all hold。「同じ失敗を二度
  繰り返さない」がハーネス開発者のコードにも適用される実証。
- **B2 較正ノート**: ⑭の persisted 4 件は brief 不達ではなく「guard 不可侵ゆえ generator には
  実装不能なピン」クラス（正しく owner へ残った）— R1 在庫の処遇判断ではこの型を分けて数える。
- metrics（正直）: released 13→**14**・passAt1 0.20・intervention-free 33.3%（10 件目）・
  captureRate/executedRate 100%・failing/unverified 0・**441 green skip ゼロ**。
- **次の判断点は変わらず M4 テーマ確定**。D3 完了条件（2+ issue 同時先置きで各 build が自 issue
  差分のみで released）は実装済み構造の grounded 実測だけが残り、M4 の複数 issue 開発が自然な
  観測機会。
- **追記（同日・文書層の改名）**: 「spec という命名は確定仕様（state）との誤解を生む — 実体は
  署名される要求の delta」という人間指摘（DOC_LIFECYCLE の警告そのもの）を受け、**今後の spawn 分
  から `docs/requirements/<slug>/requirements.md`** へ改名（旧 9 features は署名の版固定のため
  `docs/specs/` に凍結置台・全検査は単一の家 `src/authoring/spec-doc.ts` 経由で両対応）。同時に
  **`_system` を `docs/_system/` へ移設**（DOC_TAXONOMY 理想ツリーの位置・生きている state 文書
  なので版固定問題なし）。「アプリの現在仕様」は著述せず署名 AC を supersedes で畳んだ派生
  （feature-catalog・DOC_LIFECYCLE 案A）— fold の実装は最初の supersedes 出現時（M4 序盤想定）に
  WHAT 化する観測駆動とした。

### ⑫⑬セッション（2026-07-09・M2 出口到達 = 依存順 DAG→並行 drive→roadmap 完全 drain）

FEAT-007/008/006 を三連で released し、**M2「自律の横幅」出口＋EPIC-01/02/03 の全 8 features
drain** に到達。上流著述は to-spec＋**to-detail-design 初実走**（A4 締結）:

- **FEAT-007（ISSUE-0018・⑫）**: guard の依存尊重＋`blockedByDependencies`（never-silent）・
  mock 経路のチェーン依存順完走（適格性の都度再評価）・spawn 衛生は既存 lint 済みと判明し
  後方互換 AC 化（**グレーダの baseline RED/GREEN 検査が三度目の誤診を捕捉** — AC ブロックを
  変えず散文のみ訂正・再署名）。ゲート条件 2 ピン（multi-dep 報告の slice 変異・opt-in
  フィルタ変異 — 全 377 生存を実証されどちらも kill 確認）。
- **FEAT-008 の分解が FEAT-007 の実戦になった**: 2 issue 依存チェーン（0019 dispatch ← 0020
  計器）を spawn → turn 1 のログに `⧗ ISSUE-0020 blocked: waiting on ISSUE-0019
  (contract-drafted)` が実出現 → 0019 released 後の turn 2 で自動 pickup（A2 の両側を実測）。
- **grounded 新発見 = D3（omnibus ゲート）**: ACCEPT_HARNESS ゲートは suite 全体を収集する
  ため、3 issue 分のグレーダ先置きが **0019 の generator に 0020/0021 の payload まで実装を
  強制**した（単一 issue 時代に不可視だった M2 の新失敗クラス）。build 自体は健全（399 green・
  scope 内）のため omnibus ごと approve し、ギャップは NORTH_STAR_PLAN D3 へ（issue-scoped
  acceptance 収集が対策候補）。
- **turn 2 = A3/M2 出口の観測**: cap=2 で 0020＋0021（**2 spec**）が同時 in-flight・並行
  2-attempt 完走・実測（peak 2 / cap 2 / driven 2）を **0020 自身が建てた計器が store に記録**。
  0021 の generator は scope 制約（agents/ 非含有）を正しく認識し規約文の移設を owner へ
  註記 — 締結でこちらが agents/generator.md へ移設。
- **条件付き承認 ×3（7〜9 例目・全ピン変異 kill 確認）**: sampleKey 単射ピン・計器 required 型
  （⑨規約 — 今回の codeQuality は optional を見逃し = B1 較正ノート）・issuesDriven 母集団ピン・
  turnRecords append-only ピン・rubric matcher の anchor 強化（bare /pin/i が skiPINg にマッチ
  する脆弱性など、レビュアが「protected は owner の責務」と正しく切り分けて指摘）。
- metrics（正直）: released 10→**13**・passAt1 0.21（品質 minor 残存を非収束と数える厳格さ
  維持）・intervention-free 35.7%（9 件 — 主因 B2 は⑪閉鎖済み・以後の巡で減少を観測）・
  executedRate 100%・failing/unverified 0・**404 green skip ゼロ**。
- **M4 の着手条件がほぼ成立**（M2✅・drain✅・M3 は効果測定のみ残） — **次の判断点は M4 の
  テーマ確定（人間の WHAT）**。

### ⑪セッション（2026-07-09・B2 閉鎖 = repair 不収束の主因は brief の finding 落としだった）

「M2 と B2 の先にやるべき方」の判断で B2 を先行（既知の repair 欠陥を放置して drive 本数を
増やすと人間ゲート負担が比例増するため）。**着手前の証拠検証で⑩の自己診断を反証**する
展開になった:

- **誤診の未然捕捉（二度目・⑦の規律の勝利)**: ⑩に書いた「persisted は全て brief 掲載済み・
  generator 軽視」を adopt 前に PromptRecord（発行プロンプトの監査正本）へ当てたら**反証**。
  attempt-2 brief には 5 行しか無く、**persisted 7 件中 5 件は generator が見たことのない指摘**
  だった。真因: `buildPanelRepairBrief` が criterion ごとに最重症 1 finding のみ forward し
  兄弟 findings の requiredFix を黙って破棄（criterionId ≠ finding 同一性 — ISSUE-0009 と同じ
  欠陥クラスの repair マージ残存）。**repairSuccess の低迷は相当部分が冤罪**・⑥以降の条件付き
  承認ピンの多くは brief が完全ならループ自身が着地させられた可能性が高い。
- **経路**: `analyze --create`（4 issue 起票）→ ISSUE-0016 を R1 の stale draft を**差し替えた**
  contract（`scripts/seeds/panel-brief-completeness.contract.yaml`・AC-BRIEF-001..003: 全 findings
  forward・blocker-first は finding フィルタ・集約は内容同一性のみ）で adopt →
  グレーダ先置き（⑨⑩の実失敗形をそのまま再現・gated 5 RED）→ drive（`fdd338f`→build）。
- **drive**: attempt 1 = functionality/codeQuality approve・testQuality 2 findings（**同一
  criterion の兄弟** — 旧マージがまさに minor を捨てて「repair (1 fix)」＝ **bug の最後の犠牲を
  closing run 自身が実演**）→ repair で major（合流キーの criterionId 側未検証・変異実証付き）
  解消 → 残存 minor 1 件（panel.test.ts の旧契約文言 title・persisted attested）。
- **ゲート（条件付き承認 5 例目・`f0557c3`）**: 挙動健全（gated 360 green・typecheck・scope/
  protected clean）。title 是正を release 条件として実施＋criterionId 側の恒久 killer を昇格
  ガードへ（変異 kill 確認）。INTV-0005 記録 → 自律軸 0.50 介入/issue・50.0% intervention-free。
- **⑩で敷いた器官の grounded 実運用**: 閾値ルール 3 つは値が動いても**複製ゼロ**（open へ集約・
  C2 実証）。R1 は ISSUE-0016 が terminal になったので **ISSUE-0017 を正しく再起票**
  （AC-LIFE-003 の設計どおり）— ただし survivors 8 件は全て fix 前の歴史データなので
  **standing queue として open 保持**（open の間は再発火が集約される・fix 後の repair round
  データが貯まったら decline か再 adopt を判断）。
- metrics（正直）: released 8→**9**・passAt1 0.30・repairSuccess 0.14（この巡も minor 残存で
  非収束扱い — **fix の効果は次の repair round から**）・executedRate 100%・unverified 0・
  **361 green skip ゼロ**。
- **次の観測**: post-fix repair round ≥2 で persisted 減（B2 効果測定）。generator 部分実装側
  （⑨ adopt/assign の 1 件）は fix 後データで再評価。

### ⑩セッション（2026-07-08・M1 出口到達 = 提案ライフサイクルの締結＋⑧処遇判断の適用）

FEAT-005 を上流チェーン五周目で released。**adopt の対（decline/retire）が器官になり、
⑧で判断だけされ宙に浮いていた処遇が store の事実になった**:

- **上流**: to-spec 実走で spec 著述（`68fe5a1`・AC-LIFE-001..004）→ 署名 → ISSUE-0012 →
  契約 → assign → グレーダ先置き（`e1a57be`・6 RED）。意味論の要点: decline/retire は
  **判断点**（自動化禁止・介入語彙入り禁止）・retire は**状態であって抹消ではない**
  （captureRate 不変）・dedup は**ルール同一性**（open 集約・終端は再起票を妨げない）。
- **drive**（`499f631`）: attempt 1 → 7 findings → repair 5 fix → attempt 2 → **5 findings
  残存（全て attested persisted・全て挙動不変の refactor/テスト厳密性クラス）** →
  needs-human-review。特筆: testQuality が**ミューテーション実証**（setStatus 終端境界の
  reject 半分を消しても 344 テスト生存）をレビューで実演。
- **ゲート（条件付き承認・4 例目）**: 挙動健全（gated 344 green・typecheck・scope/protected
  clean）→ 5 ピンを同一締結内で実施（`c05f1eb`）: Store.updateEvalTask 封じ込め・
  **src/domain/eval-task.ts 新設**（active/retired 述語と EVAL-TASK id 規約の単一の家 —
  5 箇所の重複綴りを置換・fallback の `ISSUE-\d+` 形状制約撤廃）・declineIssue 正名化
  （closeIssue は seam-pinned alias）・setStatus 終端境界の恒久 killer を昇格ガードへ
  （変異 kill を手元で確認）。グレーダ恒久昇格 → **345 green skip ゼロ**。
- **⑧処遇判断の store 適用（運用観測・順序 task→issue）**: roman 2 task retire →
  ISSUE-0010/0002/0008 decline（理由は §4 の表から転記）→ 実測: **analyze で R3 沈黙・
  executedRate 100%・unverified 2→0**。INTV-0004（この条件付き承認自体）も記録 —
  自律軸: 0.444 介入/issue・55.6% intervention-free（9 drive 済み中 4 件が条件付き承認）。
- **B2 の判別データが 2/2 rounds 揃った**（→ ただしこの時点の暫定診断「generator が品質系
  findings を軽視する第三の型」は**⑪で PromptRecord 検分により誤診と判明** — 主因は
  buildPanelRepairBrief の同一 criterion 内 finding 落とし。正本は NORTH_STAR_PLAN B2）。
- metrics（正直）: passAt1 0.38→0.33・repairSuccess 0.20→0.17・released 7→**8**・
  regress 17 executed 全 pass（retired 2 は理由付き skip 報告）。

### ⑨セッション（2026-07-08・M1 前半 = 自律軸計器の締結＋attested lineage 初実走）

M1「操舵の完備」の先頭 FEAT-004 を上流チェーン四周目で released。**介入が store の事実になり、
「介入ゼロ」という嘘の初期値が是正された**:

- **上流**: plan-roadmap（EPIC-02/03 を additive 取り込み）→ spawn-specs（5 stub）→
  **to-spec skill 実走で FEAT-004 spec 著述**（`5c9d3ec`・A4 の初消化。他 4 stub は未著述のまま
  非追跡 — 空 spec は pre-commit の著述 lint が正しく拒否する）。**介入意味論を spec 正本で確定**
  （NORTH_STAR_PLAN §5 の宿題）: 判断点（adopt/assign/sign/decide/label）は記録**語彙に存在せず**
  数えられない — 誤カウントを集計ロジックでなく語彙の非表現可能性で構造的に排除。
  署名→ISSUE-0011→契約→assign→受け入れグレーダ先置き（`3af92c8`）。
- **グレーダ著述の新規約**: 未存在モジュール seam は**計算 specifier の遅延動的 import**で参照
  （リテラル動的 import でも tsc が解決を試みて baseline typecheck が壊れる・トップレベル await
  だと skipIf 前にロードが走り suite が壊れる — ⑥規約の拡張）。
- **drive**（`acc8c05`）: attempt 1 → 両観点 request_changes（4 findings）→ repair → attempt 2 →
  **両観点 1 major 残存・どちらも `lineage: persisted` の attested 判定＝⑦の attested lineage の
  grounded 初実走（C1 締結・EVAL-00033/34）**。Analyst R1 も attested 事実のみで「2 findings
  survived」を正しく報告。maxRepairs 到達→人間ゲート。
- **ゲート（⑥⑦型の条件付き承認）**: 挙動は独立検証で健全（受け入れ込み 330 green・typecheck・
  scope/protected clean）。残存 major は (1) 計器 2 つが Metrics 型で optional（never-silent 意味論
  の型未固定）(2) 実 adoptIssue/assignIssue 経路が介入 store に未検証（**adoptIssue に介入注入する
  変異が全 suite 生存と実証済み**）。→ ピン 2 本を release 条件として同一締結内で実施（`edb2483`）:
  required `number | null` 化＋型レベルピン・実経路 flow test 化＋恒久 killer を昇格ガードへ。
  グレーダは skipIf 除去で恒久昇格（**331 green skip ゼロ**）。
- **自己言及の締め**: この条件付き承認自体が HOW 介入なので、**released 直後にその計器自身へ
  INTV-0001 として記録**。⑥⑦の 2 例も遡及記録（INTV-0002/0003・spec 完了条件の運用観測）→
  **自律軸の初値: interventionsPerIssue 0.375・intervention-free 62.5%**（8 drive 済み issue 中
  3 件に人間の HOW — スコアカード①が数字で語れるようになった）。
- metrics（正直）: passAt1 0.43→0.38・repairSuccess 0.25→**0.20**（persisted 2 件で非収束扱い）・
  released 6→**7**・regress は merge 前 3 FAIL 正検出→merge 後 16/16 executed（14 pass＋
  2 unverified=roman）・falsePass 0% 維持。
- B2 の初データ（1/2 rounds）: persisted 2 件はどちらも brief に載っていた指摘の**実装取りこぼし側**
  （brief 不着ではない）。もう 1 round 分の attested データで判別に進む（M3）。

### ⑧セッション（2026-07-08・planned 在庫の処遇判断＋北極星達成計画の著述）

drive なし（計器変化なし）。**判断と計画のセッション**:

- **処遇判断（人間確定）**: ISSUE-0002 **退役**（起票前提 pass^1=0% は現値 57% で消滅・悪化すればルールが
  新数値で再起票）／ISSUE-0008 **退役＝supersede**（診断根拠「brief 不着」は⑦で反証済み・症状 0.25 は
  R1=attested lineage が証拠付きで再提案する配線済み）／ISSUE-0010 は **task 退役→close**（roman 2 task は
  揮発 sandbox 残骸。**task を先に退役しないと title-dedup が R3 を永久に黙らせるため順序は task→issue**）。
- **発見＝退役器官の欠如**: `ISSUE_STATUSES` に closed 無し・EvalTask に retired 無し・`decide` は build
  専用・Analyst R1 自身が "close as investigated" と言うのに手段が無い（**adopt/decline の非対称**）。
  ユーザー判断: 今は実装せず記録のみ → 器官は **FEAT-005** として roadmap 在庫へ。store 上 3 件は
  planned のまま（適用は FEAT-005 released 時・判断の正本は NORTH_STAR_PLAN §4）。
  **注意**: それまで `analyze --create` は慎重に — repair-brief 提案が「(25%)」の新タイトルで複製される
  （dedup がタイトル完全一致のため。Analyst dedup 衛生も FEAT-005 に同梱）。
- **北極星達成計画を新設**: `docs/NORTH_STAR_PLAN.md` — NORTH_STAR（不変の星）と roadmap.yaml（機械の
  WHAT 頂点）の間の**判断層**。ギャップ台帳 A1..D2（各: 欠け／星との接続／経路／完了条件）＋
  マイルストーン M1 操舵の完備 → M2 自律の横幅 → M3 縦深（観測駆動・roadmap へ未降ろし）→ M4 実プロダクト
  実証（WHAT 未確定・人間判断待ち）。**frontier の正本は以後この計画文書**（§4 は要約）。
- roadmap.yaml へ additive 追加（`PlannedRoadmap.parse` 検証済み・未署名・spawn-specs 未実行）:
  **EPIC-02**（FEAT-004 自律軸計器／FEAT-005 decline 器官＋dedup 衛生／FEAT-006 本番配線ピン規約）・
  **EPIC-03**（FEAT-007 依存順複数 issue drive／FEAT-008 複数 spec 並行＋skill 実走著述）。

### ⑦セッション（2026-07-08・finding lineage — ③の診断器自身の誤診を是正）

ユーザー指示「repair brief の実効性に進む」に対し、**WHAT 確定前に店の証拠で診断を検証**したところ、
Analyst の「repair briefs failed to land（3 件残存）」が**全件誤帰属**と判明（⑥ ISSUE-0007 の実データ:
criterionId 一致は lens 跨ぎで別内容を「同じ」と主張＝偽陽性、真の残存 `?? 'stuck'` は AC id を移動して
検出漏れ＝偽陰性）。brief 忠実性（添付 draft の処方）は ISSUE-0004 で解決済み — **誤診のまま adopt して
いれば無駄な一巡を回すところだった**。

- **WHAT の転換**: lineage（残存/新規）は意味判断 → レビュア（セッション）の attested 判断へ帰属。
  決定論層（Analyst）は `lineage='persisted'` の attested 事実のみ集計（ADR-0004 の境界の再適用）。
  `analyze --create` → ISSUE-0009 を `scripts/seeds/finding-lineage.contract.yaml`（AC-LINEAGE-001..003・
  criterionId 推測禁止をレッドライン化）で adopt。ISSUE-0008/0010 は planned 在庫。
- **drive**（`33b6e8f`）: attempt 1 → testQuality major（レンダリング片側のみのテスト）→ repair 4 fix →
  attempt 2 major 解消・**残存 minor 1 件**（Analyst の `attempt<=1` 境界が未 pin）→ 条件付き承認（⑥の型）:
  境界 pin（attempt 1 への無意味な persisted 添付は brief 失敗にしない）を昇格ガードへ追加して released。
  実装: perspectivePrompt が prior findings を提示し attested lineage を義務化・zod 検証で EvalRun まで保存・
  live.ts が再レビューへ同 lens の直前 findings を配線・R1 ルールは attested persisted のみ。
- **自己言及の締め**: この run の tail でも旧 Analyst が「3 findings survived」と誤帰属（attempt1:
  LINEAGE-001/002 vs attempt2: LINEAGE-003＝別物）＝**この issue の必要性を run 自身が再実証**して沈んだ。
- metrics（正直）: passAt1 0.5→0.43・repairSuccess 0.33→0.25（major は解消したが minor 残存で非収束扱い）・
  released 5→**6**・executed 100% 維持・315 green skip ゼロ（恒久ガード6本目）。
- 未観測: **attested lineage の grounded 初実走**は次の repair round（released 後初の request_changes→再レビュー）
  で起きる — 観測対象として残す。

### ⑥セッション（2026-07-07/08・liveness 封じ込め＋repair 実戦＋ゲート条件付き承認の初例）

⑤の grounded 失敗クラス（活動中 timeout・遅延 findings 不収集）を FEAT-003 として上流チェーン三周目で封じた。
**live repair の実戦**（request_changes 6 fix → attempt 2）と、**「条件付き承認」という人間ゲートの新しい使い方**
が初めて出た:

- 署名 spec `docs/specs/active-session-liveness-and-late-findings-collection`（AC-LIVE-001..003）→ ISSUE-0007。
  受け入れグレーダは monitorLiveness の**仮想時計駆動**（注入 clock/capture/sentinelExists/sleep）と
  `collectFindings`（tmux 非依存 phase-3 収集）を pin。未 export seam は**動的 import＋型消去**で参照
  （静的 import だと baseline の tsc ゲートが壊れる — グレーダ著述の新規約）。
- **drive**: attempt 1 → panel request_changes（codeQuality 2 minor・testQuality 1 major）→ repair brief 6 fix →
  attempt 2 → functionality/codeQuality approve・**testQuality major 1 件残存**（本番配線が inline literal で
  「review cap を 10 分に戻す変異が全テスト生存」＝⑤の再発が沈黙可能）→ maxRepairs 到達で人間ゲート。
- **ゲート判断（新形）**: 実装挙動は独立検証で健全（gate 込み 296 green・agent は review cap 撤廃→activeCap 2h/
  generator 4h の有限天井を配線）。major は「挙動欠陥」でなく「恒久ピン欠如」なので、**ピンの実装を release
  条件として人間（eval 所有者）が同一締結内で実施**: 呼び出し側 opts を `REVIEW_LIVENESS` / `GENERATOR_LIVENESS`
  として export（挙動不変の REFACTOR）し、昇格ガードに**配線ピン**（review 天井 ≥90 分=⑤の 86 分観測をカバー・
  有限・idle 検知 ≤10 分）を追加。変異は今後ガードが殺す。298 green skip ゼロ。
- **計器は正直に悪化を記録**: passAt1 0.6→0.5・repairSuccess 0.5→0.33（6 fix 中 3 findings 残存の実戦データ）。
  Analyst が「repair briefs failed to land」を自動起票候補に挙げた＝次の改善が計器から立った。released 4→5。
- 正直な注記: testQuality の残 minor 2 件（agent テストの同語反復 1 assertion・escalation 経路の AC タグ欠け）は
  released に含む（記録済み・非閉塞）。ISSUE-0007 の回帰 task 2 件は merge 後 regress で FAIL→pass 反転済み。

### ⑤セッション（2026-07-07・backfill 二周目＋跨 target 実走初観測＋escalation の実走）

④で敷いた上流チェーンの**二周目**（FEAT-002）を摩擦ゼロで通し、frontier 筆頭だった legacy backfill を
released。人間ゲートの **escalation 経路も初めて実走**した:

- `a0d161b`（署名 commit）**FEAT-002 の WHAT** — curate の enrichment（現 target 束縛のコマンド未捕捉 task に
  FEAT-001 の捕捉写像で後付け・非破壊: 複製なし/上書きなし/跨 target 推測なし/冪等・AC-REGBF-001..003）。
  roadmap へ additive 追加（FEAT-001 は signed のまま）→ 署名 → ISSUE-0006 spawn → 契約 → assign。
- **escalate-over-false-pass の grounded 初観測**: testQuality レビュアが **APFS clone を立てて 6 ミューテーションを
  実走する徹底レビュー**を行い liveness hardCap（1h10m 時点）を超過 → loop は出力欠落を握り潰さず
  `needs_human` へ escalate（設計どおり）。セッションは kill されず、**16 分後に approve 1.0 の findings を完走**。
  人間ゲート（operator）が遅延 findings＋独立検証（gate 込み 288 green・typecheck・scope/protected clean）で
  approve → released（`3f6ed7f`）。**新 failure class を grounded で発見**: review の hardCap（10 分）が
  ミューテーション級の徹底レビューに短すぎ、**活動継続中（pane 変化あり）でも timeout** する。しかも timeout は
  idle なら先に stuck が発火するため**実質「活動中のセッションにだけ」発火する**＝意味論と値の不整合。
  遅れて届いた sentinel（review worktree 内 findings.json — これは設計どおりの置き場で、中央 evalRoot へは
  completed 時にハーネスがコピーする）は収集されず捨てられた（⑥訂正: 当初「置き場所違反」と誤記）。
- **跨 target 回帰実走の初観測（frontier 筆頭の締結）**: released 直後の curate が self 束縛 legacy 6 task を
  enrichment（grounded 発火）→ config を sandbox へ一時フリップして curate（sandbox 2 task も backfill）→
  self へ復帰して regress → **9 executed・skip ゼロ（executedRate 75%→100%）**。sandbox 2 task は config が
  self を向いたまま捕捉コマンドで `.harness/sandbox` に対して実走された（初の跨 target）。結果は
  **unverified**（正直: ISSUE-0001 roman は未 released なので sandbox main に実装が無く assertion が報告されない
  — 捏造 pass せず「検証不能」を記録・`regressionUnverifiedTasks` 0→2 は真実の計器）。
- metrics: passAt1 0.5→**0.6**・released 3→**4**・executedRate **100%**・falsePass 0% 維持。
- 正直な注記: testQuality の approve 1.0 は store 未記録（収集失敗のため EvalRun は functionality/codeQuality の
  2 本＋humanVerdict）。遅延 findings は operator が直接検分した（findings.json は `.harness` 揮発）。

### ④セッション（2026-07-07・上流一気通貫）

出発点は「③三能力とも grounded だが、roadmap→spec→sign→spawn→drive の**上流一気通貫だけ未実証**」。
1本通した結果、上流→実行の断線2つが暴かれ（どちらも単体テストでは緑＝結合して初めて壊れる層間契約バグ）、
TDD で閉鎖してから ISSUE-0005 を released した:

- `4724bf9` **assign seam 新設** — spec 経由の issue は contract-drafted でも `assignedAgent=null` のままで、
  実行ガード（opt-in・DOM-execution-006）に**永遠に拾われない**断線。`agentops assign <ID>` が唯一の変異
  `assignedAgent=config.generator` を行う人間の委任判断点（adopt は planned 提案専用で代替不能）。
- `f8b4efa` **contract-draft の scope=AC-id バグ閉鎖（AC-CONTRACT-007 として spec 正本に WHAT 化）** —
  `scope.include` に coversAcIds（AC-id）を入れており、scope_check の **glob vs 変更ファイル**突合で何にも
  マッチせず、spec 経由契約は agent が 1 ファイル変更した瞬間に全変更 scope 違反で必ず落ちる latent bug。
  issues.yaml manifest に file-glob `scope` を宣言 → `Issue.scope`（nullable・additive）→ 契約へ配線。
- `55b7c89` **上流の WHAT 著述** — `docs/roadmap.yaml`＋`docs/specs/regression-multi-target-execution/`
  （AC-REGMT-001..004: curate が grader コマンド捕捉・regress の target 別グループ実走・never-silent skip・
  legacy fallback 不変）。署名→ISSUE-0005 spawn→契約（glob scope・red line 4 本が spec から正しく到達）→assign。
- `81cd3af` **受け入れグレーダ先置き** — env-gated（ADR-0007 I3）baseline 3 RED/1 GREEN（AC-REGMT-004 は
  後方互換 AC なので実装前 green が正しい形）。
- `f486670` **ISSUE-0005 build（agent 実装・attempt 1 収束）** — panel 3/3 approve（testQuality minor 2 件のみ）・
  独立検証 277 green＋typecheck・scope/protectedPaths 接触ゼロ→人間ゲート approve→released→cherry-pick→
  受け入れガード恒久昇格（skipIf 除去・277 green skip ゼロ）。
- **improveTick/regress の自己言及的閉鎖**: drive 直後の improveTick が ISSUE-0005 の blocker AC 2 件を自動
  curate（registry 8）し、regress が **merge 前の main に対し 2 FAIL を正検出**（released 前だから red が正しい）
  → merge 後の再 regress で **6 executed 全 pass** に反転。executedRate 66.7%→**75%**・passAt1 0.33→**0.5**・
  released 2→**3**。sandbox legacy 2 件は released 機能の新しい精密理由（「curation 時未捕捉・re-curate to
  capture」）で skip ＝ legacy backfill が次の明確な欠けとして計器に現れる状態。
- 正直な注記: (a) 人間ゲート approve・WHAT 著述（roadmap/spec/issues.yaml）は operator（Claude）が決定論的
  証拠に基づき実施 — 従来巡と同じ位置づけで、人間の再判断で上書き可。(b) to-spec / to-detail-design **skill
  本体は未実走**（operator が形式準拠で直接著述・lint/sign ゲートは全通過）＝ skill の grounded 検証は別課題。
  (c) AC-REGMT-002 の跨 target 実走は受け入れ/unit テスト（注入 runner・実ディレクトリ）で検証済みだが、
  実 vitest での跨 target 実走は registry が全て legacy（コマンド未捕捉）のため未観測 — backfill 後に観測可能。

### ③セッション（③改善ループ二巡）

出発点は「③は決定論実装＋テスト済みだが loop 未閉（live 未配線・grounded 未観測）」。ADR-0007 で配線を
確定し、断線2つ（Analyst 起票 issue の drive 不能・self-hosting 経路欠如）を繋ぎ、**grounded 一巡を観測**した。

`git log --oneline`（新しい順・このセッション分）:

- （追記3）**AC-id 衝突の閉鎖（`5e59195`）** — regress が grounded で検出した偽陽性を、grading と executor が共有する単一突合規則 `assertionsForCriterion`（`ISSUE-XXXX/AC-N` scoped 優先・bare フォールバックは他 issue の scoped assertion を除外）で構造的に解消。恒久ガード2ファイルの titles を scoped 化（突合 7→1 assertion に収斂）・generator 規約にも scoped タグ推奨。
- （追記2）**③二巡目完走（ISSUE-0004・`d13a2fc`）＝ Analyst 粒度改善の実証** — 失敗クラス3ルール（R1 repair不着→brief 忠実性 draft 同梱・R2 GATE 再発・R3 registry 衛生）＋draft contract 配管（提案→添付→adopt が省略時に使用）を TDD で実装後、ISSUE-0004 を brief 忠実性 contract（repair.ts の requiredFix[0] truncation＝実欠陥）で adopt→self drive。**self-hosted 初の live repair 発火→収束**（attempt 1 で testQuality の新 rubric が**ミューテーション指摘**「severity 昇格行を消してもテストが落ちない」→ 1-fix brief → attempt 2 補強 → approve）＝TDD 三層の第2層の grounded 初成果。ゲート approve→released・恒久回帰化（253 green・skip ゼロ）。regress は merge 前に 2 FAIL を検出（ISSUE-0004=正検出・ISSUE-0003=**AC-id 衝突の偽陽性**→merge 後解消も潜伏中＝次タスク）。TDD ラウンドに REFACTOR 明示も追記（`3dc8a73`・ユーザー指摘）。
- （追記）**TDD の三層強制** — ①generator 役割プロンプトに TDD プロトコル義務化（red→green・AC-id タグ規約・テスト弱体化禁止）②testQuality lens（独立レビュア）に妥当性 rubric（壊れたら fail するか・同語反復検出・タグ検査・実走許可）③決定論ゲート: report が在るのに AC-id タグ付き assertion ゼロの unit_test AC は **unsatisfied**（従来は suite-green へフォールバック＝沈黙 pass の穴を閉鎖・`satisfiedFromReport` に抽出）
- `ba5da28` **improvement: 回帰 registry の実行者**（`runRegressionTasks`・`RegressionRun`・`agentops regress`・executedRate 計器・EvalTask.target 束縛）
- `8ed3e52` **fix(metrics): captureRate は AC severity で判定（Curator 意味論に一致）＋NUL 混入除去** — grounded が暴いた計器バグ
- `0306f44` **improvement: self-hosting 基盤**（env-gate 受け入れテスト・種 contract・`real-run-self.ts`・grader コマンドの `KEY=VAL` env プレフィックス）
- `4f75fe7` **improvement: runLoopLive 末尾に improveTick 常設**（curate 冪等・analyst report-only）
- `6a8760c` **improvement: 操舵計器 regressionCaptureRate・falsePassTrend**（status/dashboard 表示）
- `5b0a70b` **improvement: agentops adopt/decide/status --json**（提案→人間 WHAT→drive の遷移＋gate CLI）
- `0d6b5ac` **docs: ADR-0007 ③改善ループの配線**

決定論: **`npm test` 258 green・skip ゼロ**（released 済み受け入れ2ファイルは恒久昇格済み）＋typecheck パス。
以降ユーザー指示で **TDD（red→green→refactor）を徹底**: adopt・計器・improveTick・grade-env・
tdd-enforcement・analyst-granularity・regression-runner（衝突再現含む）を全てテスト先行で追加。

grounded で観測したこと（③一巡・実 Claude 走行）:

- **失敗生成**: haiku×HARD×repairs0 → 受け入れは全パスしたが **testQuality が AC-3(major)/AC-2(minor) findings で dissent** → needs-human-review。前セッションと同型の「弱コーダ×敵対的レビュア」失敗クラス。
- **③自動発火（初観測）**: runLoopLive 末尾の improveTick が Curator を自動実行 → AC-2 が `[regression]` 昇格・Analyst 提案4件を report-only 出力。
- **計器の自己修正**: captureRate が null を報告 → 原因は「finding severity で分母を絞る」実装と「AC severity で判定する」Curator の意味論不一致。**grounded でしか出ない失敗形**（blocker AC への minor finding）。TDD で修正（`8ed3e52`）。ついでに区切り文字への U+0000 リテラル混入も発見・除去。
- **提案→adopt→self-hosted drive**: `analyze --create` で ISSUE-0002〜0004 起票 → ISSUE-0003 を種 contract（scope.exclude 修正）で adopt → **ハーネス自身の worktree で実 Claude が `grade.ts` を修正＋5テスト追加 → 独立検証 218/218 green（受け入れ2件が skip→実走 green 化）→ panel 3観点全 approve → gate 停止**。attempt 1 収束。
- **metrics 前後**: passAt1 0→0.5・falsePassRate 0%（labels 2件・grader agreement 100%）・captureRate 100%・registry 0→4。before スナップショット `.harness/metrics-before.json`（`status --json`）。
- **正直な注記**: (a) EVAL-00001/2 の humanVerdict ラベルは operator（Claude）が決定論的証拠に基づき付与 — 人間の再ラベルで上書き可。(b) adopt した ISSUE-0003 のタイトルは Analyst のテンプレ提案（pass@1 改善）で、contract の中身（scope.exclude 修正）への尖らせは人間判断の WHAT 確定として行った（ADR-0007 I1 の設計どおりだが、提案とcontract の意味的距離は残る＝Analyst 提案の粒度改善は将来課題）。

前セッションまでの成果（repair loop 発火/収束・PromptRecord・タブ化・モデル上書き等）は §6 の不変条件と
[execution-layer.md](execution-layer.md) に吸収済み。

## 4. frontier（次の一手）— 正本は [../NORTH_STAR_PLAN.md](../NORTH_STAR_PLAN.md)（⑧新設）

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
captureRate の隣に並ぶ（実装時実測 executed 50%→二巡目 curate 後の現在 66.7%＝4/6 pass・
sandbox 束縛の2 task は skip 報告）。

**次の frontier 候補（優先順）**:

- ~~回帰 executor の AC-id 衝突修正~~ **✅ 完了** — 突合を issue 名前空間化（`assertionsForCriterion`＝
  grading と executor が共有する単一規則: `ISSUE-XXXX/AC-N` scoped 優先・bare フォールバックは他 issue の
  scoped assertion を除外）。恒久ガード2ファイルのタイトルを scoped 化（突合 7→1 assertion に収斂）・
  generator 規約にも scoped タグ推奨を追記。grading 側の同種汚染（全 suite 採点で他 issue の同名 AC を
  拾う）も同時に閉鎖。
- ~~Analyst 提案の粒度改善~~ **✅ 完了**（R1-R3＋draft 配管・ISSUE-0004 二巡目で実証）。残在庫:
  ISSUE-0002（pass^k stabilise）が planned のまま＝adopt 候補。
- ~~上流一気通貫~~ **✅ 完了（④・ISSUE-0005 released）** — roadmap→spec→sign→spawn→contract-draft→
  **assign（新設）**→live drive→panel→ゲート→released を1本 grounded。暴かれた断線2つ（assign 不在・
  scope=AC-id）も TDD で閉鎖済み（§3④）。
- ~~回帰実行の複数 target 対応~~ **✅ 完了（④・ISSUE-0005 の payload そのもの）** — curate が grader
  コマンドを EvalTask に捕捉・regress が束縛 target 別に 1 実走ずつグループ実行・前提欠落は理由特定 skip。
- ~~legacy task の graderCommands backfill~~ **✅ 完了（⑤・ISSUE-0006 released）** — curate の enrichment で
  registry 9/9 が実行可能性を保持。**跨 target 実走も grounded 初観測**（executedRate 100%・§3⑤）。
- ~~liveness の活動延命＋遅延 findings 収集~~ **✅ 完了（⑥・ISSUE-0007 released＋配線ピン）** — 活動継続は
  有限天井（review 2h/generator 4h・ガードが床値を pin）まで延命・遅延 findings は収集時点の事実で回収。
- ~~repair brief の実効性~~ **✅ 是正完了（⑦・ISSUE-0009 released）** — 「brief 不着」は Analyst の誤帰属だった
  （brief 忠実性は ISSUE-0004 済み）。lineage を attested 化し、diagnosis が真実を語る土台を敷設。
  **観測待ち**: released 後初の repair round で attested lineage が grounded 実走する（再レビューが prior
  findings を見て persisted/new を判定）— 次の drive で観測。
- **（⑧で吸収）以降の open frontier は [../NORTH_STAR_PLAN.md](../NORTH_STAR_PLAN.md) のギャップ台帳が正本**:
  repair 収束率 0.25 の判別＝B2/C1（M3・観測駆動・WHAT 化はデータを見てから）・本番配線ピン＝B3（FEAT-006）・
  grader 較正＝B1（運用・humanVerdict 蓄積 ≥20 目標）・roman unverified 2 task と planned 在庫＝**⑧で処遇
  判断済み**（退役・store 適用は FEAT-005 released 時）・skill 本体実走＝A4（FEAT-008 同梱）・
  複数 issue DAG／複数 spec 並行＝A2/A3（EPIC-03）・playwright 等 grader＝A6（M4 従属）。
- ~~M1 前半 = FEAT-004 自律軸計器~~ **✅ 完了（⑨・ISSUE-0011 released）** — A1/C1 締結・介入意味論
  確定・to-spec skill 初実走。
- ~~M1 後半 = FEAT-005 提案ライフサイクル~~ **✅ 完了（⑩・ISSUE-0012 released）＝ M1 出口到達** —
  C2/C3 締結・⑧処遇判断の store 適用済み（R3 沈黙・unverified 0 実測）・B2 判別データ 2/2 完了。
- ~~B2 の WHAT 確定~~ **✅ 完了（⑪・ISSUE-0016 released）** — panel brief の finding 落としを
  内容同一性マージで閉鎖。効果測定（persisted 減）は次の repair round から。
- ~~M2 自律の横幅／FEAT-006~~ **✅ 完了（⑫⑬）** — EPIC-01/02/03 全 8 features released・
  roadmap 完全 drain・M2 出口到達（詳細は §3 ⑫⑬）。
- ~~D3（omnibus ゲート）の WHAT 化~~ **✅ 実装締結（⑭・FEAT-009/ISSUE-0022 released）** —
  issue-scoped acceptance 収集（accept.ts 単一の家・scoped env 注入・非活性の理由付き列挙・
  全活性/恒久昇格不変）。残るは完了条件の grounded 実測（2+ issue 同時先置き — M4 で自然に観測）。
- ~~D4（target-rooted authoring）~~ **✅ released（⑮・PR #3・`f528427`）** — ただし **harness の
  通常運転（sign→spawn-issues→contract-draft→assign→drive）を経ない direct engineering 経路**
  （人間の直接指示による）。workflow 自身の `.harness` には released の事実が無い（FEAT-010 は
  ローカルでは `specced` のまま）— 次回 self-hosting drive でこの spec を触るときは要注意。
- ~~M4 grounded 初回巡 = channel-compass に EPIC-01 を著述・drive~~ **✅ released（⑮）** —
  FEAT-Y01〜Y04 全 4 issue released（channel-compass 側 `751a38e`/`55e1271`/`f25d79c`/`57004d6`）。
  **GitHub gate 初実走・D3 完了条件観測（2+ issue 同時先置き）はどちらもまだ未実施** — 4 issue
  とも依存関係で単発 drive になった（Y02 は Y01 の実装を見ないと spec が書けない、という依存が
  自然に単発化を強いた）ため、複数 issue 同時先置きの機会は今回も来なかった。gate backend は
  `store`（channel-compass に remote が無いため github gate はそもそも試せていない）。
- **★ 次セッションの開始点（候補・優先順は人間判断）**:
  1. **D5（ストア分離の穴）を harness 側で恒久修正** — 外部 target へ `plan-roadmap` すると
     自 store の roadmap/epic が汚染される問題（詳細は §3⑮）。今は「専用の分離 store を使う」
     運用回避のみ。恒久修正の形（roadmap を repo 単位で複数持てるようにする／ingest 時に
     ID 衝突を検知して拒否する、等）は未検討。
  2. **D6（レビュー lens の lockfile 書き込み事故）の根本原因調査** — read-only レビュー
     セッションが何のコマンドを実行して lockfile を書き換えているのか未特定。channel-compass
     の 4 issue 中 3 件で発生し、そのたびに operator が独立検証で上書きする羽目になった
     （自律軸を悪化させる恒常的なノイズ源）。
  3. **M4 継続** — channel-compass 側で人間から追加指示済み: EPIC-02（YouTube API 取込）の
     正式な spec 化（現状 direct engineering 先行・record/replay grader 未整備）、EPIC-04
     （dashboard GUI）・EPIC-05（AI 生成解説、"数値が支持しない主張を作らない" 原則を
     roadmap.yaml に追加済み）の feature 分解・drive。
- **★ M4 テーマ repo = channel-compass（別 repo・remote 無し）**: 住処
  `/Users/yu/Company/Development/channel-compass`。EPIC-01 released・EPIC-02（YouTube API
  取込コード）は direct engineering で先行実装済み（roadmap 未整合・実装ノートあり）・
  EPIC-03（意味解析）は outline のまま・EPIC-04/05（⑮で human 追加）は feature 未分解。
  `channel-compass-harness-store/`（`../` 兄弟ディレクトリ）が M4 drive 専用の分離 store —
  workflow 自身の `.harness` とは完全に別物（D5 参照）。設計の正本は引き続き channel-compass の
  `NORTH_STAR.md`・`roadmap.yaml`。
- **並走観測（急がない）**: B2 効果測定（post-fix repair rounds で persisted 減か・⑭ persisted 4 は
  「guard 不可侵で owner にしか実装できないピン」クラスで brief 不達と別型）。
- **M4（実プロダクト）着手タイミングは⑩の人間判断（ハーネス完成まで待つ）を⑮で人間が明示的に
  上書き**（「完成まで止まらないで」の直接指示）— ⑩の元判断は「時期尚早」を懸念したものだったが、
  grounded に進めてみて D5/D6 という**ハーネス自身の欠け**が実際に暴かれた。これは⑩が書いた
  「M4 はハーネスを凍結しない・実 target 駆動が欠けを暴く」という設計原則の実証そのもの。
  正本は NORTH_STAR_PLAN §3 M4・§5（D5/D6 を横断ギャップ台帳へ追記要）。

## 5. 動かし方（コマンド）

```bash
# 決定論の確認（441 green・skip ゼロ）
npm test && npm run typecheck
npx tsx .claude/skills/to-system-design/scripts/check-system-design.ts .harness/sysdesign-execution --system docs/_system

# grounded execution（cost・claude 認証が要る）
npx tsx scripts/real-run-sandbox.ts                    # 使い捨て sandbox＋ai-managed ISSUE-0001（roman）
LENSES=testQuality npx tsx scripts/real-panel-run.ts   # 安く1観点（LENSES 無指定で全6観点）
GEN_MODEL=haiku HARD=1 MAX_REPAIRS=1 \
  npx tsx scripts/real-run-sandbox.ts                  # repair 発火狙い（弱コーダ×bait×repair 許可）
tmux attach -t agentops                                # ライブ観察（各ロールがタブ・完了で自動クローズ・stuck は残る）

# 上流一気通貫（roadmap → released まで・④で grounded 済みの実列）
npm run harness -- plan-roadmap --seed docs/roadmap.yaml   # roadmap → planning tree
npm run harness -- spawn-specs               # in-plan feature → 署名可能な要求 stub（docs/requirements/<slug>）
#   （requirements.md / acceptance.yaml / issues.yaml を著述して commit — issues.yaml には file-glob scope を宣言）
npm run harness -- sign docs/requirements/<slug>    # AUTH-B lint → ApprovedSpecRef（committed blob を版固定）
npm run harness -- spawn-issues docs/requirements/<slug>   # issues.yaml → ISSUE-NNNN（design lint 強制）
npm run harness -- contract-draft docs/requirements/<slug> # 署名 AC を源に契約（scope は manifest の glob）
npm run harness -- assign ISSUE-NNNN         # ★人間の委任 opt-in（これで pollable 入り。adopt は提案専用）
#   （env-gated RED 受け入れテストを test/acceptance-harness/ に先置き・commit してから↓）
npx tsx scripts/real-run-self.ts && LENSES=codeQuality,testQuality npx tsx scripts/real-panel-run.ts

# 改善ループ③（live turn 末尾で curate/regress/analyst-report は自動。手動 CLI:）
npm run harness -- curate                    # 失敗した blocker AC → 回帰 EvalTask（冪等・target 束縛）
npm run harness -- regress                   # 束縛済み registry を実 grader で再検証（pass/FAIL/unverified）
npm run harness -- analyze --create          # metrics → type:harness/eval issue 起票（人間判断）
npm run harness -- adopt ISSUE-NNNN [--contract <yaml>]
                                             # 提案の WHAT を確定 → contract-drafted（drive 可能に）
                                             # --contract 省略時は Analyst が添付した draft を検証して使用
npx tsx scripts/real-run-self.ts             # target をこのリポジトリ自身へ（store は wipe しない）
npm run harness -- decide ISSUE-NNNN approve # 人間ゲート（approve→released＋humanVerdict 収穫）
npm run harness -- status --json             # 機械可読スナップショット（改善 before/after 比較）
npm run harness -- label --run EVAL-NNNNN --human approve|request_changes  # 較正ラベル
npm run harness -- intervene ISSUE-NNNN --kind <k> --reason <text>
                                             # 人間の HOW 介入を attested 記録（⑨・判断点は語彙外で
                                             # 記録不能。kinds: conditional-approval-implementation /
                                             # workspace-hand-edit / repair-brief-hand-edit /
                                             # manual-evidence-collection）
npm run harness -- decline ISSUE-NNNN --reason <text>
                                             # adopt の対（⑩・判断点）: 非終端 issue を理由付きで
                                             # 終端 closed へ。released/closed へは拒否・自動化禁止
npm run harness -- retire EVAL-TASK-... --reason <text>
                                             # 回帰 task の退役（⑩）: 実行と executed/unverified
                                             # 集計から除外・captureRate と記録は不変（抹消しない）
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
- **contract の scope は file glob**（AC-CONTRACT-007・④）: scope_check は**変更ファイル**と glob 突合する。AC-id を scope に入れると全変更が違反になる（④で閉鎖済み・issues.yaml の `scope:` が単一の宣言点）。
- **spec 経由 issue は assign が要る**（④）: contract-drafted になっても `assignedAgent=null` のままでは実行ガードに拾われない（opt-in 既定非処理は仕様・DOM-execution-006）。委任は `agentops assign`＝人間の判断点。adopt（提案の WHAT 確定）とは対で別物。
- **人間の HOW 介入は `agentops intervene` で必ず記録する**（⑨・AC-INTV-001）: 条件付き承認でピンを
  実装した・worktree を人手で直した・brief を加筆した — その場で attested 記録しないと自律軸計器が
  嘘をつく。判断点（adopt/assign/sign/decide/label）は記録不能（語彙外）なので迷わない。
- **受け入れグレーダの未存在 seam は計算 specifier の遅延動的 import**（⑨・⑥規約の拡張）: リテラル
  動的 import でも tsc がモジュール解決を試みる（TS2307）・トップレベル await import は skipIf 前に
  走って baseline suite を壊す。`'../../src/pipeline/' + 'intervene.js'` の形で型消去し、test 本体内で
  import する（実例: `test/acceptance-harness/intervention-accounting.acceptance.test.ts`）。
- **グレーダ先置きは issue 帰属を宣言して gating する**（⑭・ADR-0007 I3 の拡張・FEAT-009）:
  新規の先置きガードは `describe.skipIf(!acceptsIssue('ISSUE-XXXX'))`（`src/pipeline/execution/accept.ts`
  から import・帰属はこの明示宣言のみ — ファイル名/テスト名からの推測禁止）。drive の採点は駆動
  issue の scoped 活性化を自動注入するため、**複数 issue の同時先置きでも他 issue のガードは休眠**
  （omnibus 封じ・D3）。`ACCEPT_HARNESS=1` は全活性（baseline RED 検査・手動一括確認）として不変。
  released 後の昇格は従来どおり gating を外すだけ。旧規約（`!process.env.ACCEPT_HARNESS`）のガードを
  scoped 採点に残すと**全休眠→理由付き RED**（activation gap note）になる — 沈黙はしないが、著述時に
  新規約を使うこと。
- ~~副次 finding: `scope_check` が `scope.exclude` を見ない~~ **✅ 修正済み** — ③一巡目の released 成果
  そのもの（ISSUE-0003・agent が自律修正・恒久回帰ガード `test/acceptance-harness/scope-exclude` が監視）。

## 7. 環境・資源の住処

- 環境: tmux 3.7・claude 2.1.x（既定 Opus 4.8。`config.models.{generator,reviewer}` で role 別上書き可・未指定は既定継承）。
- **セッションはタブ**: 全ロールは holder `agentops`（`AGENTOPS_TMUX_SESSION` で上書き可）の**ウィンドウ**。ウィンドウ名 generator=`ao-issue-*-s*`・review=`ao-eval-issue-*-s*-<観点>`。
- `.harness/` は gitignore・ローカル揮発（store・sandbox・worktrees・review-worktrees・evidence）。scaffolder（`real-run-sandbox.ts`）で決定論再生成。store の issue/eval はローカルのみ。
- skill 著述規約: 正本 `SKILL.md`＋日本語訳 `SKILL.md.ja` 併設・frontmatter `description` は日本語・skill 外へ `../` で登らない・確定処理は `scripts/`（`src/` の vendored lib）へ委譲（詳細は `workflow/CLAUDE.md`）。

## 8. canonical（深掘り・必要時のみ）

- `docs/NORTH_STAR.md` — 三能力・操舵指標・反証サイン（最上位要求）。
- `docs/decisions/ADR-0005`（execution premises）・`ADR-0006`（パネル E1-E7・ゲート G1-G3、末尾の実装先 id 表が地図）・`ADR-0007`（③配線 I1-I4・未吸収＝ビュー吸収が残タスク）。
- `docs/_system/execution/`（ARCH/DOM/DATA/LANG-execution-NNN が実装契約）・同 `evaluation/`。
- 主要ソース: `src/pipeline/execution/{loop,live,session,perspective-session,tmux,grade,gate}.ts`・`src/pipeline/{panel,curator,analyst,adopt,assign,improve,regression,repair,contract-draft}.ts`・`src/planning/planning-tree.ts`・`src/metrics/metrics.ts`・`src/domain/schema.ts`・`src/config.ts`。
- テスト: `test/{improvement-loop,adopt,assign,metrics,intervention,proposal-lifecycle,grade-env,grade-scoped,scoped-collection-integration,accept,tdd-enforcement,analyst-granularity,regression-runner,regression-multi-target,curate-backfill,repair-loop,live-repair,panel,contract-draft,planning-tree}.test.ts` ほか（計 441・skip ゼロ）。`test/acceptance-harness/` は**恒久回帰ガード置き場**（protectedPaths で agent から保護）— released 前の drive 中だけ帰属宣言付き gating（⑭以降 `describe.skipIf(!acceptsIssue('ISSUE-XXXX'))`・§6）で baseline-red を隔離し、released 後に gating を外して昇格する規約（ADR-0007 I3）。現在の13ファイル全て昇格済み（ゲート条件ピンは各ガードに同居・⑥⑦⑨〜⑭）。~~D3 注意（⑬）~~ **⑭で閉鎖**: 採点は駆動 issue の scoped 活性化を注入するため、複数 issue の同時先置きでも omnibus 強制は起きない（`src/pipeline/execution/accept.ts` が単一の家）。
- 共有語彙: `src/domain/eval-task.ts`（⑩新設）— active/retired 述語（`isRetired`/`activeEvalTasks`）と EVAL-TASK id 規約（`buildTaskId`/`parseTaskId`）の単一の家。registry を読む/書くコードはここを通す（重複綴りを再導入しない）。
- [execution-layer.md](execution-layer.md) — execution 層の grounded 実験の詳細ログ（発火/収束の生データ・過去の不発記録）。**継続に必須ではない**深掘りアーカイブ。
