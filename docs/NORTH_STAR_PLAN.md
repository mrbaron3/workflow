# 北極星達成計画（ギャップ台帳と残工程の正本）

> 位置づけ: [NORTH_STAR.md](NORTH_STAR.md)（不変の星）を頂点とする**判断層**。
> 「残り何を・なぜ・どの経路で・何をもって完了とするか」をここに保持する。
> 機械が食う WHAT の頂点は [roadmap.yaml](roadmap.yaml) — 本書のマイルストーンから
> **熟した feature だけを additive に降ろす**（未成熟な WHAT を先に焼き込まない）。
> セッション単位の作業前線は HANDOFF §4（本書への要約ポインタ）。
> 作成: 2026-07-08（⑧セッション）。計器値は `agentops status --json` の実測。
> 更新規約: 各マイルストーン締結時・ギャップの発見/解消時に本書を更新する。

## 1. 現在地（証拠）

済んでいること（全て grounded・origin/main）:

- **一巡が回ることは三能力とも実証済み**: 上流一気通貫 ×5（ISSUE-0005/0006/0007/0011/0012）・
  改善ループ完走 ×8（released 8）・repair 実戦・escalation・条件付き承認・跨 target 回帰・
  **attested lineage grounded 実走 ×2（⑨⑩・repair round 2 巡分の persisted 判定が store に）**。
- **自律軸が計測可能になった（⑨・A1 締結）**: interventionsPerIssue 0.444・
  howNonInterventionRate 55.6%（⑥⑦⑨⑩の条件付き承認 4 件が attested・遡及込み）。
- **在庫が循環可能になった（⑩・C2/C3 締結・M1 出口到達）**: decline/retire 器官＋ルール同一性
  dedup が released。**⑧の処遇判断は store 適用済み**（roman task 2 件 retire → ISSUE-0010/0002/
  0008 close・R3 沈黙と unverified 0 を実測確認）。
- **repair 不収束の主因を閉鎖（⑪・B2 締結）**: panel brief の finding 落としを内容同一性マージへ
  修正（ISSUE-0016 released）。repairSuccess の相当部分は冤罪だったことが確定。
- **M2「自律の横幅」出口到達（⑫⑬）**: 依存順 DAG drive（FEAT-007）→ その実戦の上で
  2 spec 同時 in-flight（FEAT-008・cap=2・実測 peak 2 を 0020 自身の計器が記録）＋配線ピン規約
  （FEAT-006）。**EPIC-01/02/03 の全 8 features released ＝ ハーネス roadmap 完全 drain**。
  skill 実走（to-spec / to-detail-design）も締結（A4）。新発見 D3（omnibus ゲート）は台帳へ。
- **D3（omnibus ゲート）の実装を締結（⑭・FEAT-009/ISSUE-0022 released）**: 受け入れ収集が
  駆動 issue に scoped され、複数 issue 先置きの構造穴が閉鎖（§2 D3 — 完了条件の grounded
  実測だけが残る）。merge 直後の regress が operator 自身のピンの環境感度バグを正検出→即閉鎖
  （操舵指標が eval 所有者のコードにも働いた初例）。
- 計器（2026-07-09 ⑭実測）: released 14 / passAt1 0.20 / falsePass 0% / captureRate 100% /
  executedRate 100%（failing 0・unverified 0）/ 自律軸 0.67 介入/issue・33.3% intervention-free
  （条件付き承認 10 件 attested — この型の主因 B2 は⑪閉鎖済み。⑭の残存 4 findings は
  「ガード不可侵ゆえ owner にしか実装できないピン」クラスで、brief 不達ではない）/
  並行計器 peak 2 / cap 2 / driven 2 / **441 green skip ゼロ**。
- **M4 の着手条件がほぼ成立**: 「M2＋M3 landed・roadmap 概ね drain」のうち M2✅・drain✅
  （EPIC-01..04 全 9 features released）。M3 は主因閉鎖✅＋効果測定（post-fix repair rounds の
  persisted 減）が観測中 — 揃い次第、**M4 のテーマ確定（人間の WHAT・§5）が次の判断点**。
  D3 の完了条件（2+ issue 同時先置き）は M4 の複数 issue 開発が自然な観測機会。
- **（⑯ 設計統合・grounded release 無し）ビジョン言語化で目標像を再確認し、入口 altitude を確定**:
  人間が「GitHub に issue を立てたら AI が拾って PR→release」を再言語化。棚卸しの結果、
  パイプラインの大半（planning=`to-system-design`・Issue Contract=parse で ready・7観点パネル・
  専用コンテキスト=tmux セッション＋`scoped-context`・決定論オーケストレータ・pass@k/pass^k）は
  **既に実装済み**で、言語化が炙り出したのは (i) 人間の**入口**が未成立（GitHub は出口＝PR ゲートのみ・
  `guard` は store を見て GitHub Issues を見ない）、(ii) パネルの**モデル非依存 routing**（A5）が seam
  止まり、(iii) **UI/UX 著述ペルソナ**不在、の 3 点。入口の altitude を人間が確定（theme repo の
  GitHub Issue＝入口 → planning-agent が contract-ready へ昇格 → 決定論 intake が store へ）＝**ADR-0008**。
  新ギャップ **D7（intake）/A7（UI/UX 著述）** を台帳へ・**A5 を最優先の構造ギャップへ昇格**（本節 §2）。
- **（2026-07-23 PR #8 grounded発見）PRが自動ループの外にある構造穴を確定**:
  旧headへのP1→修正push後の再レビュー結果をハーネスが追跡できず、PR作成前パネル承認とGitHub上の
  revision reviewが分断されていた。人間が目標動作を再確定: **PRを先に作り、current headを複数観点で
  review→blocking findingを同branchへ修正→全観点再review→gate通過時に自動merge→次task**。
  **D8（PR-native delivery）**をADR-0009/EPIC-11へ追加。同時に既存Octolink daemonを汎用化する
  **D9（Webhook trigger＋poll reconciliation＋複数repo GUI）**をADR-0010/EPIC-12へ追加。
- **（2026-07-25〜26・CISO-01..07 grounded）隔離production基盤とbounded self-dogfoodが成立**:
  Go control＋TypeScript runner＋PostgreSQLをApple Containerの3コンテナへ統合し、Registration起点の
  Issue/PR monitor、private broker、webhook/poll dedup、MONITOR_ONLY→ACTIVE→DRAINING→OFF、
  restart persistence、real Codex job、Codex/Claude 2ラウンドcurrent-head review、repair、
  expected-head mergeを実証した。CISO-05では固定Designflow contractからrequest-changes→revision 2の
  digest-bound approve→7 capability reconciliation→Dashboard→Playwright/UX/a11yまでを実走した。
  2026-07-28にはWF-DF-001..008の汎用consumerを作業ツリー内へ実装し、CISO golden replayに加えて、
  CISO固有path／digest／Issue番号を持たない新規fullstack Source Snapshotを
  request-changes→明示resume→revision 2→backend/UI Issue→headless evidence→releaseまで完走した。
  ただしCISO-07はpre-main bootstrapを明示したbounded cutoverであり、D7/D8の通常watch turn、
  D9の複数repo常駐forwarder、A5/A6のstore計器付き標準経路、Designflowのremote/live black-box実証を
  完了扱いにはしない。

残りを一言で: **(a) 測れていない軸を測る、(b) 横幅（規模・並行・多様性）、
(c) 縦深（診断→改善の精度）、(d) 自分以外を開発する実証。**

## 2. ギャップ台帳（北極星の操舵指標・反証サインから逆引き）

記法 — **経路**: 上流チェーン（roadmap→spec→署名→spawn→assign→drive）｜直接TDD（④ assign 型の
基盤 seam）｜運用（drive のたび蓄積）｜観測（起きるのを待って記録）。**完了**: 証拠になる観測。

### ① 自律（操舵: HOW 非介入率 ↑・issue あたり介入回数 ↓）

| ID | 欠け | 星との接続 | 経路 | 完了条件 |
|---|---|---|---|---|
| A1 | ~~**自律軸の計器が無い**~~ **✅ 締結（⑨・ISSUE-0011 released）** — attested 介入記録（判断点は語彙外）＋ status の interventionsPerIssue / howNonInterventionRate。⑥⑦の 2 例＋⑨自身の条件付き承認が遡及/即時に記録済み（INTV-0001..0003） | 測れない軸は steer できない → **計測可能になった** | 上流チェーン（FEAT-004） | ~~完了条件~~ 達成: `status --json` に両計器が並び 3 例がカウント済み（0.375 / 62.5%） |
| A2 | ~~複数 issue の DAG 駆動未実証~~ **✅ 締結（⑫⑬・ISSUE-0018 released → 実戦）** — guard が依存を尊重し `⧗ ISSUE-0020 blocked: waiting on ISSUE-0019 (contract-drafted)` が live ログに実出現・released 後の turn で自動 pickup を実観測（turn 1→2 で両側） | 下流トレースが 1 issue 規模 → 依存チェーンが秩序立って流れる | 上流チェーン（FEAT-007） | ~~完了条件~~ 達成 |
| A3 | ~~複数 spec 並行未実証~~ **✅ 締結（⑬・ISSUE-0019/0020/0021 released）** — cap=2 の turn で 2 spec の issue（0020/0021）が同時 in-flight・2-attempt サイクルを並行完走・実測は 0020 自身が建てた計器が store に記録（peak 2 / cap 2 / driven 2） | 規模の欠け → 並行が実測付きで回る | 上流チェーン（FEAT-008） | ~~完了条件~~ 達成 |
| A4 | ~~skill 本体の grounded 未実走~~ **✅ 締結（⑨〜⑬）** — to-spec は⑨以降の全 spec 著述で実走・to-detail-design は⑬（FEAT-008 の 2 issue 依存分解・check-detail-design 通過）で初実走 | 上流の著述が再現可能な部品に | 運用 | ~~完了条件~~ 達成 |
| A5 | **✅ 構造実装済み（2026-07-14）／grounded release待ち** — `AgentInvocation`、Claude/Codex interactive adapter、role/Perspective routingを実装。security=Codex・他=Claude等を同一panelへ配線でき、EvalRun→invocation→実provider/modelを監査可能。旧PromptRecordはlegacy保持 | 北極星の「誰の・何のため」（複数エージェント前提）に対する欠け | **EPIC-07 FEAT-013..015 実装済み** | 残り: claude以外を含む実remote runで1 released・provider別計器のgrounded証拠 |
| A6 | **✅ 構造実装済み（FEAT-019）／grounded実走待ち** — method-keyed command registry、AC単位env、未設定fail-closed、artifact evidence、Curator/Regression captureを実装。unit_test legacy aliasも維持 | 実プロダクト（D1）の AC を宣言methodそのもので証拠採点する | EPIC-09 / FEAT-019 | 残り: playwright等unit_test以外のmethodで実target AC 1件をgrounded採点・回帰する |
| A7 | **✅ 構造実装済み（FEAT-020/021）／grounded UI実走待ち** — frontend/fullstack Candidateごとに専用route/fresh contextのUI designerがprinciples/token/component/state/interaction/a11yをACへtraceして著述。schema・trace・Invocation provenanceのall-or-nothing gate通過後だけIssueへ写り、generator/reviewerが同じ契約を参照。不在・曖昧・不正はneeds-human-review | UI を要する theme で HOW 自律の被覆が UI 設計まで及ぶこと | EPIC-10 FEAT-020/021実装済み | 残り: UIを要する実target 1 featureでartifact著述→playwright採点→ux/a11y review→releaseをgrounded実測する |
| A8 | **✅ 汎用intake構造＋ローカルgrounded headless成立／remote・live実証待ち** — 固定RC consumer、provider port、Source Issue→Design Request、draft→design→final planning、digest/decision/review gate、Capability→Issue/AC/system/API、明示provider移行を実装。CISO 7 capability／9 APIをgolden replayし、無関係なfullstack Source Snapshotもrequest-changes→明示resume→exact supersession approve→backend/UI Issue→expected-head merge→releaseまで通した。release lineageは全capability参照Issueと同一headのPlaywright/UX/a11y証拠を検証する | 「WHATだけから動くソフトウェア」には、実装前に目的達成の労力と視認性を人間が判断でき、frontend/backendを同じ体験根拠から設計できることが必要 | ADR-0012／#24・#26〜#33。TypeScript 942 pass（29 skip）、Go 5 package pass | 残り: remote Designflow、live GitHub claim/check/merge/close、実target、VoiceOver/NVDA・high contrast/zoom・物理deviceのblack-box証拠 |

### ② 評価（操舵: 証拠裏付き判定率 ↑・false-pass 率 ↓）

| ID | 欠け | 星との接続 | 経路 | 完了条件 |
|---|---|---|---|---|
| B1 | **grader 較正セット不足**（humanVerdict 5 issue 分・testQuality の揺れが定量化できない） | falsePass 0% が「分母が小さいだけ」の可能性を排除できない | 運用（drive 毎に decide/label で蓄積） | labeled runs ≥20・falsePassTrend が統計的に意味を持つ |
| B2 | ~~repair 収束率低迷の原因未判別~~ **✅ 主因を閉鎖（⑪・ISSUE-0016 released）**。判別の経緯: ⑩の暫定診断「generator 軽視」を PromptRecord 検分で自己訂正 — persisted 7 件中 5 件は brief 不達（`buildPanelRepairBrief` の同一 criterion 内 finding 落とし・criterionId ≠ finding 同一性）。修正: 合流キーを内容同一性（criterionId＋requiredFix 連言）へ・blocker-first は finding フィルタ化・恒久ガード＋変異 killer 2 本。**closing の run 自身が旧マージの最後の犠牲を実演**（attempt 1 の兄弟 minor が brief から落ち persisted）。**残る観測**: fix 後の repair round で persisted が実際に減るか（R1 の標準在庫 ISSUE-0017 が歴史 8 件を保持 — fix 後データが貯まった時点で decline か再 adopt を判断）。generator 部分実装の側（⑨ adopt/assign の 1 件）は fix 後データで再評価 | 「同じ失敗を二度繰り返さない」の repair 版 → 主因閉鎖・効果測定待ち | 完了（③ adopt 経路） | ~~ガード~~ 済み。次: post-fix repair rounds ≥2 で persisted 減の grounded 観測 |
| B3 | ~~「本番配線」盲点の一般化未着手~~ **✅ 締結（⑬・ISSUE-0021 released）** — generator 規約（agents/generator.md）＋testQuality rubric に検査項目＋棚卸しピン（DEFAULT_PANEL_MAX_CONCURRENT 単一ソース化・SUBMIT_RETRY export）。matcher は変異検証済み anchor（bare /pin/i が skiPINg にマッチする脆弱性まで閉鎖） | false-pass の構造穴 → 三層で封鎖 | 上流チェーン（FEAT-006） | ~~完了条件~~ 達成 |
| B4 | **✅ 構造実装済み／grounded観測待ち** — 全required Perspective承認後にrequired check／外部blocking reviewが棄却したrevisionをsurrogate/oracle mismatchとして導出。同一revision一票・次reviewerへ詳細なし件数だけを返し、edge/adversarial/falsifiable検査を強化する（ADR-0018）。mismatchの耐久記録と、opaque signalを受けた次revisionで同クラス再発を防いだ観測は未収集 | 正解全文が無い開放タスクでも独立反証から検証器を改善する | PR-native運用 | mismatch→次revision promptへのopaque signal→同クラス再発防止を実PRで1件grounded観測 |

### ③ 改善（操舵: pass@k/pass^k 時間推移 ↑・eval レジストリ成長・修正回数 ↓）

| ID | 欠け | 星との接続 | 経路 | 完了条件 |
|---|---|---|---|---|
| C1 | ~~**attested lineage の grounded 初実走待ち**~~ **✅ 観測済み（⑨）** — ISSUE-0011 の repair round で両観点の再レビューが prior findings を見て persisted を attested（EVAL-00033/00034）。Analyst R1 も attested 事実のみで「2 findings survived」を正しく報告（⑦以前の誤帰属と対照） | ③の診断器が真実を語る根拠 → 実証された | 観測 | ~~完了条件~~ 達成: lineage 付き EvalRun が store に残存 |
| C2 | ~~**Analyst の dedup がタイトル完全一致**~~ **✅ 締結（⑩・ISSUE-0012 released）** — Suggestion に安定 ruleId・dedup は「open 在庫に同ルール」で集約・終端（closed/released）は再起票を妨げない | 在庫がノイズ製造器 → ルールごとに高々 1 open へ収束 | 上流チェーン（FEAT-005） | ~~完了条件~~ 達成: 集約/非沈黙の回帰テストが恒久ガードに |
| C3 | ~~**decline 器官が無い**~~ **✅ 締結（⑩・ISSUE-0012 released）** — `agentops decline/retire`（理由必須・終端・監査可能・自動化禁止・介入語彙外）。**⑧の処遇判断を store へ適用済み**: roman task 2 retire → ISSUE-0010/0002/0008 close・analyze で R3 沈黙・unverified 2→0 を実測 | 判断点の半分が記録不能 → adopt/decline が対に | 上流チェーン（FEAT-005） | ~~完了条件~~ 達成 |
| C4 | **改善対象の広がり未実証**（北極星は grader / prompt / skill / routing / 新エージェントまで謳うが、実績は harness コード修正と rubric 追記が主） | 「改善可能」の射程が狭い | 観測→上流チェーン（B2 の判別結果が prompt/routing 系の一手を要求した時に踏む） | harness コード以外の対象（prompt/routing 等）への改善 issue が 1 巡 released |

### 横断

| ID | 欠け | 星との接続 | 経路 | 完了条件 |
|---|---|---|---|---|
| D1 | **実target一巡済み／WHAT-only remote release未実証** — channel-compassで4 issueをreleased済み。ただしdirect engineering＋store gateであり、GitHub Issue入口からHOW介入0でreleaseした証拠ではない | 究極目標「人間は WHAT のみ→動くソフトウェア」の最終実証 | 上流チェーン（M4・target=channel-compass確定済み） | ハーネス外の実 target でGitHub WHAT→released一気通貫・A1計器がHOW介入ゼロを示す |
| D2 | ~~並行時の資源運用~~ **✅ 初期分締結（⑬・ISSUE-0020）** — 並行 turn の実測（peak/driven/cap）が store の事実＋status 計器に。コスト天井・多 turn 集計は未着手（必要になった分だけ） | 横幅の安全前提 → 最低限の可視化あり | 直接TDD | 資源計器が status に出る ✅（コスト系は将来） |
| D3 | ~~受け入れゲートが suite 全体収集＝issue 横断の payload 漏出~~ **✅ 実装を締結（⑭・FEAT-009/ISSUE-0022 released）** — issue-scoped acceptance 収集: 活性化の単一の家 `accept.ts`（`acceptsIssue`/`scopedAcceptEnv`・帰属は guard の明示宣言・describe 粒度）＋grade の駆動 issue env 注入＋非活性の理由付き列挙（never-silent）＋全活性/恒久昇格の不変。self-drive 設定から suite 全体活性 prefix を撤去（omnibus の入口を閉鎖）。条件付き承認 10 例目（休眠≠失敗の報告整合・own-all-dormant の LOUD 化・衝突優先順位ピン — 全変異 kill）。**残る観測**: 台帳の完了条件そのもの＝2+ issue の同時先置きで各 build が自 issue の AC 差分だけで released になる grounded 実測（次の複数 issue 開発、自然には M4 で起きる） | 複数 issue 分解の意味（PR サイズ・帰属・並行の意義）が omnibus 化で崩れる → 構造は閉鎖・実測待ち | 完了（上流チェーン・EPIC-04） | 実装✅。次: 2+ issue 同時先置きの grounded 観測で本行を完全に畳む |
| D4 | ~~外部 target の WHAT 著述が harness repo 固定~~ **✅ released（⑮・PR #3）** — `resolveTargetRoot`（config.ts）が spawn-specs/sign の起点を統一。**ただし direct engineering 経路**（harness の通常運転＝sign→spawn-issues→contract-draft→assign→drive を経ていない）。channel-compass への EPIC-01 実 drive で実地検証済み（4 issue released） | M4 の repo 分離モデルが上流チェーンの入口で成立することを grounded 実証 | 完了 | 外部 repo への spawn→署名→spawn-issues→contract→drive 一気通貫 ✅（gate backend は `store` のみ実証・`github` は channel-compass に remote が無く未実証） |
| D5 | **✅ 構造実装済み（FEAT-011）** — 1 store=1 canonical target binding、全mutation CLI preflight、legacy明示bind、mismatch fail-closed。現storeも明示移行済み | ADR-0001の組織境界 | EPIC-06 / FEAT-011 | 残り: 外部target往復時のgrounded mismatch証拠 |
| D6 | **✅ 構造実装済み（FEAT-012）** — reviewer checkoutとevidence sidecarを分離。既知lockfile副作用は帰属してfindings保持、source/config変更は従来どおりdiscard | ②評価のfalse-escalation抑止 | EPIC-06 / FEAT-012 | 残り: 次の実live panelで3/4発生が消えるgrounded観測 |
| D7 | **✅ 入口配線＋bounded self-dogfood済み／通常外部target縦断待ち** — store-first GitHub claim、planning detached session、全AC source/system trace gate、`github-turn`/`watch-github`→既存runLoopLive/PR gateを実装。CISO-07 #17はSource Snapshotとplanning provenanceを保存して実remote PR/releaseまで到達したが、pre-main bootstrapを含む自己更新cutoverだった | 究極目標「人間は WHAT のみ」の入口 | EPIC-08 | 残り: cutover特例なしの外部target ready Issue→異種provider panel→GitHub PR→releaseとHOW介入0計器 |
| D8 | **✅ 構造実装＋CISO-07 current-head/repair/expected-head merge実証済み／通常継続turn待ち** — PRを初回Perspective前に作成し、EvalRun/Invocationを`(prId, headSha)`へ束縛。CISO-07でCodex/Claudeのread-only 2ラウンド、confirmed finding修正、Round 3なし、最終CI、expected-head mergeを証拠化した。ただしbounded cutoverのため次task自動継続までの通常経路は未観測 | 「承認済みなのに同じrevisionへP1」のfalse-passを禁止し、人間mergeを通常経路から外す | EPIC-11 / FEAT-022..024実装済み | 残り: 通常watch turnでP1→修正push→全観点再review→merge→released→次taskを連続実測 |
| D9 | **✅ Go/PostgreSQL隔離controlへ移行・単一登録grounded済み／複数repo常駐待ち** — CISO-07でpersist-before-ack、webhook/poll dedup、Registration router、private Issue/PR broker、restart recovery、loopback GUIをApple Container上で実証。credentialをargvへ出す旧`gh webhook forward`は正直に失敗記録し、成功根拠にしていない | Issue/PR/review/checkを即時に同じ自律loopへ戻し、複数targetを運用可能にする | EPIC-12＋CISO #10でGo controlへstrangler移行 | 残り: 2+ repoの常駐delivery/forwarder/reconciliationと安全なlocal forwarder transportをgrounded実測 |

## 3. マイルストーン（依存順・「測る→広げる→深める→実証する」）

順序の理由は北極星の文そのもの — 「自律が運用を回し、**評価が良し悪しを証拠で判定し**、
**改善が次の自律をより賢くする**」。測れない軸を残したまま横幅を広げない。

- **M1 操舵の完備** = ~~A1✅＋C2✅＋C3✅~~ **✅ 出口到達（⑩）**: 星の全軸が計測可能✅・
  在庫が判断可能なキューとして循環✅・⑧の処遇判断が store に適用済み✅。
  roadmap: **EPIC-02（FEAT-004/005/006すべて✅）**。B1 の蓄積は継続（labeled 13 runs / 5 issue 分。注: 条件付き承認の
  巡は recordHumanDecision が label を収穫しない — approve 側 run が無いため。蓄積を進めるなら
  `agentops label` での個別付与が要る）。
- **M2 自律の横幅** = ~~A2✅＋A3✅＋A4✅（D2 初期分✅）~~ **✅ 出口到達（⑫⑬）**:
  「1 issue・1 spec 規模」の但し書きがスコアカードから消えた。roadmap: **EPIC-03
  （FEAT-007✅/008✅）＋EPIC-02 残の FEAT-006✅** — **EPIC-01/02/03 全 8 features released
  ＝ roadmap 完全 drain**。⑬が暴いた新ギャップ D3（omnibus ゲート）は台帳へ。
- **M3 評価→改善の縦深** = ~~C1（観測）~~✅→B2（判別・attested データ 1/2 rounds）→次の一手（C4 に波及し得る）。
  **roadmap へはまだ降ろさない**（判別データを見てから WHAT 化 — ⑦の教訓）。
  M1/M2 の drive が repair round を供給するので、M3 は並走する観測として進む。
  出口: repairSuccess の改善、または「brief 系/レビュア系」の証拠付き判別と対応 issue。
- **M4 究極目標の実証** = D1（＋A5/A6 従属）。**着手済み（⑮・人間が明示的に前倒し）** —
  ⑩の元判断（「ハーネスが一通り完成してから着手」）は ⑮ で人間の直接指示（「完成まで止まらないで」）
  により上書きされた。M4 の drive で channel-compass の EPIC-01 が実際に released し（§3⑮）、
  **設計原則どおり実 target 駆動がハーネス自身の欠け D5/D6 を grounded で暴いた**（「改善は
  プロダクトと同じ loop」の実証）。
  **進め方の原則（変わらず）: M4 はハーネスを凍結しない。** 暴かれた欠けは同じ roadmap・
  同じ loop（③改善）で直す。
  **⑯以降の実装順をroadmapへ確定**: **EPIC-06**（D5 store-target binding → D6 reviewer
  workspace integrity）で状態と評価の足場を閉じ、**EPIC-07**（A5 invocation provenance →
  provider backend → role/perspective routing）、**EPIC-08**（D7 GitHub poll/claim → traceable
  planning enrichment →実remote縦断）の順で進む。A7/A6 は非UI intakeを塞ぐhard dependencyにせず、
  UI要求を検出したときだけ理由付きで停止する条件付き能力として後続化する。
  **2026-07-23追記**: EPIC-08の実remote縦断前に、PRの意味論を**EPIC-11（D8）**でPR-native loopへ
  修正する。即時イベント配送は**EPIC-12（D9）**で追加するが、正しさはpoll reconciliationでも成立させる。
  実装順は FEAT-022 revision identity → FEAT-025 durable inbox → FEAT-023 review/repair →
  FEAT-024 atomic merge/continuation → FEAT-026 multi-repo runtime → FEAT-027 GUI。
  出口: 自分以外のソフトウェアが WHAT だけから released になり、A1 計器がそれを証明する
  — **一部到達**（EPIC-01・4 issue released）。ただし D4 が direct engineering 経路だった
  ことと、D5/D6 が operator の都度介入を要求したことから、**「HOW に人間が触れず」の条件は
  まだ厳密には満たしていない**（INTV-0001..0004・decide のたび Claude Code 権限分類器が
  self-approval を検出＝§3⑮）。A1 計器を M4 の channel-compass 分離 store 側でも計測するか
  どうかは未確定（現状 workflow 本体の自律軸には合算されない）。
  **2026-07-26追記**: CISO-07はworkflow自身を実remote Source Issueから隔離基盤へ通す
  bounded self-dogfoodを成立させ、D7/D8/D9の環境・current-head・merge境界をgroundedにした。
  ただしpre-main bootstrapを含むため、M4出口は外部targetで同じ通常経路とHOW介入0計器を
  再現した時点まで開いたままとする。

## 4. planned 在庫の処遇（⑧・2026-07-08 人間確定）

| 対象 | 判断 | 根拠 |
|---|---|---|
| ISSUE-0002（pass^1 0%） | **退役** | 起票前提が現計器（pass^1 57%）で消滅。悪化すればルールが新数値で再起票するため失う情報ゼロ |
| ISSUE-0008（repair briefs 33%） | **退役＝supersede** | 診断根拠（brief 不着）は⑦で反証済み・brief 忠実性は ISSUE-0004 で解決済み。症状（0.25）は R1（attested lineage）が証拠付きで再提案する配線済み。title-dedup の%焼き込みにより保留の備忘機能も無い |
| ISSUE-0010（registry hygiene）＋roman task 2 件 | **task 退役→close** | EVAL-TASK-ISSUE-0001-AC-1/2 は揮発 sandbox（wipe される）残骸でガード価値ほぼゼロ（跨 target 初観測の歴史的役割は⑤で記録済み）。**task を先に退役しないと title-dedup が R3 を永久に黙らせるため、順序は task→issue** |

適用: **✅ 適用済み（⑩・FEAT-005 released 直後）** — 決定どおり task→issue の順で
EVAL-TASK-ISSUE-0001-AC-1/2 retire → ISSUE-0010 → ISSUE-0002 → ISSUE-0008 close（理由は
本表を各レコードの closedReason / retiredReason に転記済み）。適用後の実測: analyze で
R3 沈黙・executedRate 100%・unverified 0。dedup がルール同一性化されたため
`analyze --create` の複製懸念も解消（ルールごとに高々 1 open）。

## 5. 未確定の WHAT（人間判断待ち）

- **M4 の実プロダクト**: ハーネスに開発させる最初の外部 target を何にするか。
  **タイミング確定（⑩・2026-07-09）: 着手時に決める**（ハーネス「一通り完成」後 = M3 の M4
  マイルストーン参照）。それまで**テーマは意図的に未確定**にする — 選定は着手時の
  ハーネスの実力（A6 grader 対応の有無・M2 の並行度）に合わせるのが正しく、今縛らない。
  選定基準の提案（着手時の参考・拘束ではない）: (i) AC が unit_test 中心で書ける規模から
  始める（A6 を最初から要求しない）、(ii) 失敗しても実害の無い自前プロダクト、
  (iii) 複数 issue に自然に割れる規模（M2 の成果を使う）。
  **✅ テーマ確定＝channel-compass（別 repo で進める・⑭で scaffold・EPIC-01 設計完了）**:
  **repo = `/Users/yu/Company/Development/channel-compass`**（別 git・ローカル・remote 無し・commit `fc293ce`）。
  「参照・競合チャンネル群を横断分析し新規チャンネルの方向性を決めるツール」。**テーマは別 repo で
  進める** — その WHAT（NORTH_STAR・roadmap・EPIC-01 = Y01→Y02→Y03→Y04 の設計判断）は
  **channel-compass に著述・一元化**し、本書はポインタに留める（reference don't copy・正本は
  channel-compass の `roadmap.yaml`/`NORTH_STAR.md`）。**round 1 のサイズ調整はテーマでなく最初の
  EPIC で行う**（計画の木）: EPIC-01 は fixture 上の決定論分析中核に限定・grader は live API/secret を
  採点に持ち込まない（決定論制約）。着手順: **D4（target-rooted authoring）を作る →
  channel-compass に EPIC-01 を著述・drive**（GitHub gate 初実走・D3 完了条件観測を兼ねる）。
  詳細な開始点は HANDOFF §4「★ 次セッションの開始点」。
- **M4 の repo 関係モデル ✅ 確定（⑭・2026-07-09 人間確定）**: workflow repo＝**開発組織**
  （機構・store・組織自身の WHAT）／テーマ repo＝**開発対象**（コード・テスト・受け入れガード・
  **自分の WHAT**: NORTH_STAR/roadmap/requirements/_system — DOC_TAXONOMY の理想ツリーを
  テーマ repo に適用）。接点は 2 つ: `config.target`（repo/graders/protectedPaths/systemDir）と
  **人間ゲート＝テーマ repo の GitHub PR**（backend='github'・M4 で初 grounded）。M4 は
  ハーネスを凍結しない（テーマ drive が暴く欠けは同じ loop でこの repo の issue に）。
  前提ギャップは D4（target-rooted authoring）— M4 準備の最初のハーネス作業。
- **M4 の人間入口 ✅ 確定（⑯・2026-07-14 人間確定）**: theme repo の **GitHub Issue（粗い WHAT）＝入口**。
  planning-agent が整合検証＋ドメインモデル浮き彫りで **Issue Contract-ready（parse）まで昇格**させ、
  決定論の **intake アダプタ**が store へ写す（GitHub Issue は投影・PR ゲートと同型に `externalRef`＋poll）。
  取り込み後は既存 drive loop が不変で流れる（**入口の配管だけが新規**）＝**ADR-0008**。上流チェーン（spec 入口）は
  self-hosting 用に残す（I5）。前提ギャップは **D7（intake）**、依存は **A5（モデル非依存 routing）/A7（UI/UX 著述）**。
  未決（spec 時）: GitHub 上の ready 表現・昇格の帰属記録・self の入口を issue へ寄せるか（ADR-0008 未決節）。
- ~~**M1 の介入計器の意味論**~~ **✅ 確定（⑨）**: spec
  `docs/specs/autonomy-axis-instruments-human-how-intervention-accounting` が正本 —
  判断点（adopt/assign/sign/decide/label）は記録語彙に存在せず数えられない。数えるのは
  HOW への関与 4 種（conditional-approval-implementation / workspace-hand-edit /
  repair-brief-hand-edit / manual-evidence-collection）。
