# 自律軸計器（人間の HOW 介入の会計）受け入れ要件

> このファイルは Development Department への入力契約であり、人間が機能の **WHAT（受け入れ基準）** を
> 著す source of truth。frontmatter は持たない（meta・署名は ApprovedSpecRef が持つ）。
>
> **WHAT/HOW 境界**: 本 spec が定義するのは「人間の HOW への関与が store に事実として残り、
> 自律軸（HOW 非介入率・issue あたり介入回数）が計器に並ぶ」という観測可能な性質。
> 記録 CLI の形・schema のフィールド設計・計器の算出式の置き場所は実装の裁量。
>
> **介入の意味論（NORTH_STAR_PLAN §5 の確定 — 本 spec が正本）**:
> 北極星が保証する人間の**判断点**（WHAT 確定 adopt/sign・委任 assign・承認/審査 decide/label・
> 較正ラベル）は介入では**ない** — 判断点の行使は自律の定義の一部であり、数えると判断点を消す
> 圧力になる。数えるのは**HOW への関与**: 条件付き承認で人間が実装を持ち込む（⑥⑦の型）・
> agent の作業空間への人手編集・repair brief の人手加筆・証拠の人手回収（⑤の型）等。
> この境界は記録語彙そのものに焼き込む: 判断点は語彙に存在せず、記録できない。
>
> **背景（⑥⑦の grounded 実例）**: ISSUE-0007 は testQuality major（配線ピン欠如）を人間が
> 「ピンの実装を release 条件として同一締結内で実施」して released、ISSUE-0009 も境界 pin の
> 昇格ガード追加を人間が実施して released。どちらも人間の HOW 関与だが store に痕跡が無く、
> 操舵指標「HOW 非介入率」が反証サイン（人間が HOW に介入しないと進まない）を検出できない。
>
> **参照する固定制約**: `DOM-execution-007`（審査ゲートの状態遷移 — release は人間の判断点）／
> `ARCH-evaluation-006`（metrics — EvalRun 群からの計器算出）／`ARCH-evaluation-008`
> （store＝source of truth — 状態は tmux や人の頭でなく store に住む）／
> [NORTH_STAR](../../NORTH_STAR.md)（操舵指標: HOW 非介入率 ↑・issue あたり介入回数 ↓）。
> dependsOn は acceptance.yaml に置く。

## 意図（roadmap-planner が定めた outcome）

- 機能: Autonomy-axis instruments (human HOW-intervention accounting)
- outcome（価値・なぜ今）: 人間の HOW への介入（条件付き承認での実装持ち込み・repair への人手等）が store に事実として残り、status に issue あたり介入回数と HOW 非介入率が並ぶ。WHAT 確定・承認・審査は介入に数えない（判断点は消さない）。⑥⑦の条件付き承認 2 例が遡及して数えられる。
- 計画の木リンク: feature=FEAT-004 epic=EPIC-02

## サブ機能一覧

> この一覧は設計層への分割境界ヒントであり、slice ではない。

| ID | サブ機能 | 優先度 |
| --- | --- | --- |
| INTV-A | 介入の attested 記録（判断点は語彙外という意味論込み） | 高 |
| INTV-B | 自律軸計器（status への露出） | 高 |
| INTV-C | 遡及記録（released 済み issue への適用） | 中 |

## INTV-A 介入の attested 記録

**ユーザーストーリー**

- 誰が: 人間（operator / eval 所有者）
- 何を: 自分が行った HOW への関与を、対象 issue に紐づく事実として store に記録する
- なぜ: 記録されない介入は「人の頭にある状態」であり、自律軸の計測を不可能にする。
  介入は恥ではなく操舵データ — 隠れるほど「自律できているふり」の false-pass になる

**事前条件**

- 対象 issue が store に存在する（status は問わない — INTV-C）。
- 介入の種別語彙は HOW 関与のみを含む（判断点は表現不能 — 上記意味論）。

**受け入れ基準**

- **[AC-INTV-001] 正常系: HOW 介入が attested な事実として store に残る**
  - Given drive された issue と、人間の HOW への関与（例: 条件付き承認でゲート条件の実装を
    人間が持ち込んだ — ⑥⑦の型）
  - When その介入を種別と理由を添えて記録する
  - Then 介入事実が issue に紐づき、種別・理由・記録時刻とともに store から監査できる。
    理由の欠落・語彙外の種別（WHAT 判断点を含む）は記録できず、理由付きで loud に拒否される

- **[AC-INTV-002] 意味論境界: 判断点の行使だけを受けた issue の介入回数は 0**
  - Given WHAT 確定（adopt / sign）・委任（assign）・承認/審査（decide / 較正 label）だけを
    受けて released に至った issue（介入記録なし）
  - When 自律軸計器を算出する
  - Then その issue の介入回数は 0 と数えられ、HOW 非介入側に分類される（判断点の行使は
    介入として表現も集計もされない）

## INTV-B 自律軸計器

**ユーザーストーリー**

- 誰が: 進行管理役・人間（操舵判断）
- 何を: status の機械可読出力で「issue あたり介入回数」と「HOW 非介入率」を他の計器と並べて見る
- なぜ: 測れない軸は steer できない。反証サイン「人間が HOW に介入しないと進まない」は
  この計器が下がる形でしか検出できない

**受け入れ基準**

- **[AC-INTV-003] 正常系: 自律軸が既存計器と並んで機械可読に出る**
  - Given 介入記録を持つ issue と持たない issue が混在する store
  - When 計器を算出する（status の機械可読出力）
  - Then issue あたり介入回数（drive 済み issue に対する介入総数の比）と HOW 非介入率
    （drive 済み issue のうち介入記録ゼロの割合）が数値で並ぶ。drive 済み issue が無い store
    では両計器とも null（未観測を 0 や 1 と混同しない — never-silent）

## INTV-C 遡及記録

**ユーザーストーリー**

- 誰が: 人間（operator / eval 所有者）
- 何を: 既に released された issue に対しても、過去に行った HOW 介入を遡及して記録する
- なぜ: ⑥⑦の条件付き承認 2 例は計器の敷設前に起きた。遡及できなければ自律軸の初期値が
  「介入ゼロ」という嘘から始まる

**受け入れ基準**

- **[AC-INTV-004] 遡及: released 済み issue への介入記録が計器に反映される**
  - Given 既に released の issue（⑥⑦の条件付き承認の型）を含む store
  - When その issue へ過去の HOW 介入を記録し、計器を再算出する
  - Then 記録は新規 issue への記録と同様に受理・監査可能で、issue あたり介入回数と
    HOW 非介入率が再計算に反映される（released が記録を拒む理由にならない）

**非機能要件**

- 決定論: 計器は store の内容だけから再計算可能（記録と算出は分離され、算出は純関数的）。
- 可観測性: 介入事実は issue 単位で store から列挙・監査できる。
- 互換性: schema 変更は additive — 既存 store（介入記録なし）はそのまま parse でき、
  介入ゼロとして扱われる。

**完了条件**

- 自動テスト: 記録の正常/拒否・意味論境界・計器算出（混在 store / 空 store）・遡及 各 1 以上。
- 運用観測（released 時・grader 対象外）: ⑥⑦の 2 例（ISSUE-0007 / ISSUE-0009 の条件付き承認）を
  実 store へ遡及記録し、status に自律軸が実数で並ぶこと。

## レッドライン

> 実装が絶対にしてはならないこと。

- `apps/agentops/test/acceptance-harness/**` に触れない（ハーネス所有の独立採点者・protectedPaths）。
- 人間の判断点を消さない・自動化しない: adopt / assign / sign / decide / label の判断点は
  本機能の後も残る（計器は判断点を数えないのであって、無くすのではない）。
- 介入を推測で自動生成しない: 明示的に attested された記録だけが介入事実（⑦の教訓 —
  診断器の推測は偽陽性/偽陰性を生む）。
- 既存 store レコードを破壊しない（additive schema・破壊的 migration をしない）。
- 合格基準（既存テスト）を弱体化しない。
