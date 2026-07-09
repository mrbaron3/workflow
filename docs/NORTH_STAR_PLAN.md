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
- 計器（2026-07-08 ⑩実測）: passAt1 0.33 / pass^1 0.44 / repairSuccess 0.17 / falsePass 0% /
  captureRate 100% / executedRate 100%（unverified 0） / 345 green skip ゼロ。

残りを一言で: **(a) 測れていない軸を測る、(b) 横幅（規模・並行・多様性）、
(c) 縦深（診断→改善の精度）、(d) 自分以外を開発する実証。**

## 2. ギャップ台帳（北極星の操舵指標・反証サインから逆引き）

記法 — **経路**: 上流チェーン（roadmap→spec→署名→spawn→assign→drive）｜直接TDD（④ assign 型の
基盤 seam）｜運用（drive のたび蓄積）｜観測（起きるのを待って記録）。**完了**: 証拠になる観測。

### ① 自律（操舵: HOW 非介入率 ↑・issue あたり介入回数 ↓）

| ID | 欠け | 星との接続 | 経路 | 完了条件 |
|---|---|---|---|---|
| A1 | ~~**自律軸の計器が無い**~~ **✅ 締結（⑨・ISSUE-0011 released）** — attested 介入記録（判断点は語彙外）＋ status の interventionsPerIssue / howNonInterventionRate。⑥⑦の 2 例＋⑨自身の条件付き承認が遡及/即時に記録済み（INTV-0001..0003） | 測れない軸は steer できない → **計測可能になった** | 上流チェーン（FEAT-004） | ~~完了条件~~ 達成: `status --json` に両計器が並び 3 例がカウント済み（0.375 / 62.5%） |
| A2 | **複数 issue の DAG 駆動未実証**（`dependsOnIssues` は schema のみ・実行ガードが尊重するか未検証） | 「roadmap→epic→issue」の下流トレースが 1 issue 規模で止まっている | 上流チェーン（FEAT-007） | 依存チェーン（2+ issues）が依存順に自動 drive・未 released 依存のブロックが理由付きで見える |
| A3 | **複数 spec 並行未実証**（tmux/worktree/コスト衝突の挙動不明） | 同上（規模の欠け） | 上流チェーン（FEAT-008） | 2 spec の issue 群が同時 in-flight で完走 |
| A4 | **to-spec / to-detail-design skill 本体の grounded 未実走**（④⑤⑥は operator 直接著述で代替） | 上流の著述自体が再現可能な部品になっていない | 運用（M2 の spec 著述を skill 経由で行う） | skill 実走ログ＋lint/sign 通過 |
| A5 | **generator が claude のみ**（codex/gemini は enum・pluggable 設計のみ。「誰の・何のため」は複数エージェント前提） | 北極星の「誰の・何のため」に対する欠け | 上流チェーン（M4 で必要になってから） | claude 以外で 1 released・`byAgent` が 2 行になる |
| A6 | **unit_test 以外の grader 未対応**（playwright 等） | 実プロダクト（D1）の AC が unit_test だけでは書けない | 上流チェーン（M4 従属） | unit_test 以外の method で AC 1 件が証拠採点される |

### ② 評価（操舵: 証拠裏付き判定率 ↑・false-pass 率 ↓）

| ID | 欠け | 星との接続 | 経路 | 完了条件 |
|---|---|---|---|---|
| B1 | **grader 較正セット不足**（humanVerdict 5 issue 分・testQuality の揺れが定量化できない） | falsePass 0% が「分母が小さいだけ」の可能性を排除できない | 運用（drive 毎に decide/label で蓄積） | labeled runs ≥20・falsePassTrend が統計的に意味を持つ |
| B2 | **判別完了（⑪・PromptRecord で確定・⑩の暫定診断を自己訂正）**。⑩時点の「全 persisted は brief 掲載済み・generator 軽視」は**誤診だった** — attempt-2 の発行プロンプト（PromptRecord＝正本）を検分した結果、persisted 7 件中 **5 件は brief に一度も載っていない**: `buildPanelRepairBrief` が criterion ごとに最重症 1 finding だけ残すマージで**同一 criterion の別 findings の requiredFix を黙って捨てていた**（⑨ optional-type・⑩ Store 直接変異/述語重複/regex/naming）。残り 2 件のみ forwarded-だが-部分実装。**主因は brief の finding 落とし＝決定論コードの欠陥**（criterionId ≠ finding 同一性 — ⑦の lineage の教訓と同じ欠陥クラスが repair マージに残存）。prompt 系改善（C4）ではない | 「同じ失敗を二度繰り返さない」の repair 版 → 主因が unit_test で pin 可能な形で特定された | 上流チェーン（③ adopt 経路・draft 差し替え） | 全 panel findings の requiredFix が brief に到達する回帰ガード＋次の repair round で persisted 減の grounded 観測 |
| B3 | **「本番配線」盲点の一般化未着手**（⑥ major: inline literal の定数は変異が全テスト生存。pollMs / maxConcurrent / panel 閾値等に同類があり得る） | false-pass の構造的な穴（テストが本番配線を見ていない） | 上流チェーン（FEAT-006: 規約＋rubric＋棚卸し） | 棚卸しで見つけた該当箇所がピン化・testQuality rubric に項目・変異テストで再発検出 |

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
| D1 | **実プロダクト未経験**（ハーネスは自分自身と roman bait しか開発していない） | 究極目標「人間は WHAT のみ→動くソフトウェア」の実証が自己言及の外に無い | 上流チェーン（M4）。**何を作るかは人間の WHAT — 未確定（§5）** | ハーネス外の実 target で WHAT→released 一気通貫・A1 計器が HOW 介入ゼロを示す |
| D2 | **並行時の資源運用**（コスト/tmux/worktree の天井と計器） | 横幅（A2/A3）を安全に踏む前提 | M2 で必要になった分だけ直接TDD | 並行 drive 中の資源計器が status に出る |

## 3. マイルストーン（依存順・「測る→広げる→深める→実証する」）

順序の理由は北極星の文そのもの — 「自律が運用を回し、**評価が良し悪しを証拠で判定し**、
**改善が次の自律をより賢くする**」。測れない軸を残したまま横幅を広げない。

- **M1 操舵の完備** = ~~A1✅＋C2✅＋C3✅~~ **✅ 出口到達（⑩）**: 星の全軸が計測可能✅・
  在庫が判断可能なキューとして循環✅・⑧の処遇判断が store に適用済み✅。
  roadmap: **EPIC-02（FEAT-004✅/005✅/006 残）** — FEAT-006（配線ピン規約・B3）は M1 出口には
  不要だった規約系の残在庫。B1 の蓄積は継続（labeled 13 runs / 5 issue 分。注: 条件付き承認の
  巡は recordHumanDecision が label を収穫しない — approve 側 run が無いため。蓄積を進めるなら
  `agentops label` での個別付与が要る）。
- **M2 自律の横幅** = A2＋A3＋A4（D2 従属）。
  roadmap: **EPIC-03（FEAT-007/008）**。spec 著述を skill 実走で行い A4 を同時に消化する。
  出口: 「1 issue・1 spec 規模」の但し書きがスコアカードから消える。
- **M3 評価→改善の縦深** = ~~C1（観測）~~✅→B2（判別・attested データ 1/2 rounds）→次の一手（C4 に波及し得る）。
  **roadmap へはまだ降ろさない**（判別データを見てから WHAT 化 — ⑦の教訓）。
  M1/M2 の drive が repair round を供給するので、M3 は並走する観測として進む。
  出口: repairSuccess の改善、または「brief 系/レビュア系」の証拠付き判別と対応 issue。
- **M4 究極目標の実証** = D1（＋A5/A6 従属）。
  **着手条件（⑩・2026-07-09 人間確定）: ハーネスが「一通り完成」してから着手する** —
  自然な読みは M2（自律の横幅）＋M3（縦深）が landed し、ハーネス自身の roadmap
  （EPIC-01/02/03）が概ね drain した状態。測る土台（M1✅）の上に、広げる（M2）・深める（M3）
  まで揃えてから、外部の実 target へ向ける。
  **テーマ（何を作るか）は着手時に決める（§5）** — 今は未確定のままにする（未成熟な WHAT を
  先に焼き込まない）。
  **進め方の原則: M4 はハーネスを凍結しない。** 実プロダクトを作りながらのハーネス改修は
  当然織り込む — 実 target こそが最も厳しい grounded 試験であり、ハーネスの欠けを暴く。
  暴かれた欠けは**同じ roadmap・同じ loop**（③改善）で直す（北極星の「改善はプロダクトと
  同じ loop」の原則そのもの）。M4 の drive が新しいハーネス改善 issue を供給する双方向。
  出口: 自分以外のソフトウェアが WHAT だけから released になり、A1 計器がそれを証明する。

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
- ~~**M1 の介入計器の意味論**~~ **✅ 確定（⑨）**: spec
  `docs/specs/autonomy-axis-instruments-human-how-intervention-accounting` が正本 —
  判断点（adopt/assign/sign/decide/label）は記録語彙に存在せず数えられない。数えるのは
  HOW への関与 4 種（conditional-approval-implementation / workspace-hand-edit /
  repair-brief-hand-edit / manual-evidence-collection）。
