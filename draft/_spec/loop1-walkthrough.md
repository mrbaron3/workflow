# loop 1 通し図 — 1 機能が端から端まで流れる様子

本書は仕様ではなく **オリエンテーション（メンタルモデルの地図）** である。各モジュール仕様
（[README](README.md) の地図・[modules/](modules/)）と ADR は「**なぜそう決めたか**」を高高度で記録するが、
「**結局どう動くか（what happens, step by step）**」の通し説明をどこも持たない。本書がそれを埋める。

- 目的: 読者（人間）が **仕組みと勘所を 1 本の具体例で掴み、実装に着手できる**状態になること。
- 射程: [README §8](README.md) の **loop 1（自律 × 評価 × 改善を閉じる最薄の縦 1 本）** のみ。loop 2+ は対象外。
- 性質: 本書は contract altitude（ADR-0003 D26）を**侵さない**。新しい契約を定義せず、確定済みの契約を
  具体値で**辿るだけ**。よって仕様の SoT ではない（齟齬があれば modules/ と ADR が優先）。

> **使い方**: まず §3 の二つの状態機械を頭に入れ、§4 の通しを上から読む。引っかかった所が、あなたの
> 理解の穴であり、同時に仕様の説明不足の候補。§7 の穴マップで「今すぐ実装できる範囲」を確認する。

---

## 1. 一行ずつの登場人物（loop 1 に出る範囲）

| ID | 名前 | 一行で | loop 1 の spec |
| --- | --- | --- | --- |
| M20 | オーサリング層 | 人間+AI で spec.md / acceptance.yaml を共著し、人間が署名する | 下書き(v2) |
| M21 | Design Planner | 承認済み spec から三層設計（system/spec/slice）を著し、PR サイズに分解する | 下書き |
| M22 | Design Reviewer | M21 の設計を **spawn 前**に独立審査し DesignScorecard を出す | 下書き |
| M05 | Issue Contract Planner | 版固定された承認物を **機械的に** IssueContract へ投影（resolve）する | 下書き |
| M03 | Coordinator | 状態機械・dispatch・ロック・worktree を持つ **決定的コード**の背骨 | **未着手（穴）** |
| M06 | Generator | IssueContract を読んで実装し PR を作る | **未着手（穴）** |
| M07 | Evaluator | PR を独立評価し EvalScorecard を出す | **未着手（穴）** |
| M09 | Evaluation Harness | 隔離環境で実際に grader（npm test 等）を回し証拠を残す | **未着手（穴）** |
| M08 | Repair Router | scorecard → 修正指示・試行回数管理 | **未着手（薄）** |
| M10 | Eval Curator | 失敗を回帰 eval に昇格する | **未着手（薄）** |

prose で言うと: **M20 が「何を作るか」を固め、M21 が「どう作るか」を設計し、M22 がその設計を審査し、
M05 が契約に変換し、M03 がそれを実行に乗せ、M06 が作り、M07/M09 が採点し、M08/M10 が失敗を糧にする。**
このうち spec があるのは前 4 つ（全部下書き）だけで、背骨の M03 と実行側 M06/M07/M09 は spec ゼロ（§7）。

---

## 2. 二層の SoT（どこに真実が住むか）

flow を追う前に、**真実（source of truth）が二か所に分かれている**ことだけ掴む（ADR-0001 D4/D5）。

- **オーサリング SoT = リポジトリ内のファイル**（spec.md / acceptance.yaml / 設計ファイル）。Git 履歴で版管理。
- **実行 SoT = issue / PR の状態・ラベル**。

そして両者をつなぐのが **「埋め込まず、版固定参照で渡す」原則**（D8）。issue は契約本体を抱えず、
`path@gitSha`（**blob SHA**。内容が変われば SHA が変わる）で元ファイルを指すだけ。これにより
**drift（承認した版と現版のズレ）を機械的に検知**できる。この一点が設計全体の背骨になっている。

---

## 3. 二つの状態機械（loop 1 の骨格）

loop 1 は **spec（spec.md 1 枚）** と **issue（work order）** の二段ライフサイクルで動く（ADR-0001 D9/§5）。
**状態ラベルを書くのは常に M03（決定的コード）**。M21/M22 などの LLM は「完成したよ」と**シグナルするだけ**で、
状態は書かない（「状態遷移を LLM にやらせない」原則）。

```text
spec（spec.md）ライフサイクル — オーサリング + 設計。issue 化の前:
  planned → ready-for-contract → contract-drafting(協業) → contract-approved(人間署名)
          → designing(M21) → design-reviewed(M22 pass) → decomposed(issue 群を spawn)
                ↑__________________________|  M22 changes-requested は designing へ差し戻し（設計内側ループ）

issue（work order）ライフサイクル — spawn 時に生成:
  ready-for-generation → generation-in-progress → ready-for-evaluation →
  evaluation-in-progress(全 pass) →
  [human_review ゲート: MR/release があれば needs-human-review へ] →
  build-approved → ready-to-release →（人間リリースゲート）→ released
       ↑_______ request_changes は Repair 経由で generation へ戻る（実装内側ループ）
```

**対称性が勘所**: 設計にも実装にも「独立評価者 → scorecard → 該当箇所だけ差し戻し」の**内側ループ**がある。
設計側 = M21 著者 ↔ M22 審査（spawn 前）。実装側 = M06 生成 ↔ M07 評価（PR 後）。

---

## 4. 通し — Todo に「期限(dueDate)」を足す 1 機能

題材は誰でも分かる小さな機能にする。**3 つの受け入れ要件が自然に 2 スライスへ割れ、共有基盤が 1 つ出て、
人間監査が 1 件付く**形を選んだ（内側ループと drift を見せるため）。

### Hop 0 — 人間が機能を思いつく

「Todo に期限を付けたい。期限切れは赤く出したいし、期限順で並べたい」。ここはまだ自然言語。

### Hop 1 — M20 オーサリング層（人間 + AI 協業 → 署名）

人間が **behavior（WHAT）** を `spec.md` に書く。AI が各 AC に **verification（採点方法）** を `acceptance.yaml`
で提案し、自動採点できない要件を `manual-requirements.md` へ振り分ける。最後に人間が署名する。

**spec.md は人間向けのプロダクトドキュメント**（受け入れ基準は名前付き Given/When/Then・ユーザーストーリー・
完了条件）であって YAML ではない。機械が必要とするのは **各シナリオに振った AC-ID 1 つだけ**（acceptance.yaml
との join キー・被覆チェック用）。ドメイン/データ等の全体共有事項は system 層を参照する（ADR-0004 D31）。

`specs/todo-due/spec.md`（人間向けドキュメント。機械が要るのは AC-ID アンカーのみ）:

```markdown
# Todo に期限(dueDate)を追加 受け入れ要件

<!-- meta(featureId=TODODUE / area=fullstack / specId=SPEC-TODODUE)・署名は spec 状態オブジェクト(M18)が持つ -->
<!-- ドメイン概念・業務ステータスは system 層(_system/)を固定制約として参照する -->

## サブ機能一覧

| ID | サブ機能 | 優先度 |
| --- | --- | --- |
| TODODUE-A | 期限の永続化と入力 | 高 |
| TODODUE-B | 期限切れ表示と並べ替え | 中 |

## 期限の永続化と入力

**ユーザーストーリー**

- 誰が: Todo 利用者
- 何を: Todo に期限(dueDate)を設定したい
- なぜ: 締切を忘れず、近いものから対処したいから

**事前条件**

- 既存の Todo データがある(dueDate を後付けする)。

**受け入れ基準**

- **[AC-TODODUE-001] 正常系: 期限の保存**
  - Given Todo の作成/編集画面
  - When 期限を入力して保存する（未入力も可）
  - Then 期限が永続化され、未入力時は null として保存される

## 期限切れ表示と並べ替え

**受け入れ基準**

- **[AC-TODODUE-002] 正常系: 期限切れ表示**
  - Given 期限が過去の Todo がある
  - When 一覧を表示する
  - Then その行が赤く(overdue 表示で)表示される

- **[AC-TODODUE-003] 正常系: 期限ソート**
  - Given 期限の異なる複数の Todo
  - When 期限順の並べ替えを行う
  - Then 期限の近い順に並ぶ（null は末尾）

## やってはいけないこと (red lines)

- 既存の Todo レコードを破壊しない(dueDate 欠如は null として読める後方互換)。
```

> AC-ID は `**AC-TODODUE-001**` のように行頭の太字アンカーで埋め込むだけ。正規表現で抽出でき、
> 被覆/排他チェックと acceptance.yaml への join が成立する一方、文書は人間向けの読み物のまま保てる。
> severity は採点属性ゆえ spec.md でなく acceptance.yaml に置く（下記）。meta・署名は frontmatter ではなく
> spec 状態オブジェクト（ApprovedSpecRef）が持つ（実物の spec.md にも frontmatter は無い）。

`specs/todo-due/acceptance.yaml`（AI 協業・grader 向け。AC-ID をキーに join）:

```text
verifications:
  AC-TODODUE-001:
    severity: blocker            # 採点・blocking 判定に使う属性ゆえ grader 側(ここ)に置く
    method: api_test
    expected:
      - "POST /todos {dueDate} で永続化され GET /todos に dueDate が返る"
      - "dueDate 省略時は null で永続化される"
  AC-TODODUE-002:
    severity: major
    method: playwright
    expected:
      - "期限が現在より過去の Todo の行に class='overdue' が付く"
  AC-TODODUE-003:
    severity: major
    method: unit_test
    expected:
      - "compareByDue により dueDate 昇順に整列する（null は末尾）"
```

`specs/todo-due/manual-requirements.md`（自動採点できない要件は隔離する。B 方針）:

```text
manualRequirements:
  - id: MR-TODODUE-001
    severity: major
    requirement: 期限の境界判定がユーザーのロケール/タイムゾーンで正しい。
    tier: human_review        # ← この tier が後で human_review ゲートのトリガになる
    verifier: 人間
```

署名すると M20 tooling が **ApprovedSpecRef** を作り、**spec 状態オブジェクト（M18 store）へ永続**する
（issue はまだ無いので、issue には置けない＝O2 の核心）。これが「どの版を承認したか」の権威ある記録:

```text
ApprovedSpecRef:
  specId:            SPEC-TODODUE
  featureId: TODODUE / area: fullstack    # meta（frontmatter でなくここが持つ）
  approvalCommitSha: a1b2c3…              # 署名 commit。真正性/監査用
  behaviorRef:       { path: specs/todo-due/spec.md,             gitSha: <blob-sha> }
  verificationRef:   { path: specs/todo-due/acceptance.yaml,     gitSha: <blob-sha> }
  manualRequirementsRef: { path: specs/todo-due/manual-requirements.md, gitSha: <blob-sha> }
  systemRefs:        []                   # 参照した system 層の固定制約（この例は新規参照なし）
  approvedAcIds:     [AC-TODODUE-001, AC-TODODUE-002, AC-TODODUE-003]
  acFingerprints:    # AC 単位の内容ハッシュ（GWT behavior + severity + verification）。drift 判定の基準
    AC-TODODUE-001: h1
    AC-TODODUE-002: h2
    AC-TODODUE-003: h3
  approvedAt:        2026-06-18T10:00:00Z
```

> 勘所: **人間が触る上限はここまで**（spec.md / AC / 署名）。この下の設計・実装は全部 AI 著者になる
> （ADR-0001 D13/D16）。だからこそ「設計の独立審査（M22）」が必須になる（次の Hop で効いてくる）。

### Hop 2 — M21 Design Planner（三層で設計し PR サイズに割る・AI）

M03 が spec を `designing` にする。M21 は承認物と **関連する system 層**を gitSha で pin して読み、三層で著す:
**system 層**（全体で単一・必要分だけ additive 拡張）/ **spec の design-delta**（拡張の記録）/ **slice**（PR サイズ）。
この Todo はドメイン概念を増やさず、**データに1カラム**と判定/ソートの**共有基盤**を足すだけ（domain-map は触らない＝adaptive）。

system 層への追加（global・追加のみ）。`specs/_system/data-model.md` と `architecture.md` に各1要素を additive 追加:

```text
data-model.md   + DATA-014  todos.dueDate 列（nullable・ISO8601 文字列）。既存行は null として読める（後方互換）。
architecture.md + ARCH-031  共有モジュール core/dueDate（公開シェイプのみ・内部実装は書かない）:
                              - isOverdue(todo, now): boolean
                              - compareByDue(a, b): number
                            期限の「意味」を各所で二重実装しないための共有 seam。
```

`specs/todo-due/design-delta.md`（spec がどの system 層をどう拡張したか）:

```text
DesignDelta (SPEC-TODODUE):
  reads:   []                                   # 既存 system 要素は前提にしていない
  extends:
    - { artifact: data-model,   elementId: DATA-014, affectsAcIds: [AC-TODODUE-001,002,003] }
    - { artifact: architecture, elementId: ARCH-031, affectsAcIds: [AC-TODODUE-002,003] }
```

`specs/todo-due/slices/SLICE-TODODUE-001.md`（slice・PR サイズ・1 スライス=1 issue）:

```text
DesignSlice (SLICE-TODODUE-001  期限の永続化と入力):
  narrative: { productGoal: 期限を保存・編集できる, userStory: 期限を設定したい（忘れないため） }
  coversAcIds: [AC-TODODUE-001]
  coversMrIds: []
  dependsOnSystem: [DATA-014]              # system 要素を参照（複製しない）
  dependsOnSlices: []
  componentDesign:                          # seam/契約レベルのみ。内部構造は書かない
    - 作成/編集フォームに dueDate 入力欄。API は dueDate を受理・永続化
  testApproach: api_test で POST→GET 往復と null 既定を exercise
  estimatedScope: S
```

`specs/todo-due/slices/SLICE-TODODUE-002.md`:

```text
DesignSlice (SLICE-TODODUE-002  期限切れ表示と並べ替え):
  narrative: { productGoal: 期限切れを一目で分かり期限順に並べる, userStory: 締切が近い順に見たい }
  coversAcIds: [AC-TODODUE-002, AC-TODODUE-003]
  coversMrIds: [MR-TODODUE-001]            # human_review トリガを背負う
  dependsOnSystem: [DATA-014, ARCH-031]    # 共有基盤 core/dueDate(ARCH-031) を参照
  dependsOnSlices: [SLICE-TODODUE-001]     # 永続化が先（依存順）
  componentDesign:
    - 一覧が core/dueDate の isOverdue で overdue クラス付与、compareByDue でソート
  implementationNotes?: （任意・非ゲート）大量件数なら事前計算…等を固定したい時だけ書く
  testApproach: playwright(overdue 表示) + unit_test(compareByDue 昇順)
  estimatedScope: M
```

被覆チェック（M21 の不変条件）: `{001} ∪ {002,003} == {001,002,003}` ＝ spec の AC 全集合と**双方向一致**。
スライス間で AC 重複なし（排他）。OK。各スライスについて **IssueSpawnOrder**（参照集合・全 Ref 版固定）を出力＝
**設計完成をシグナル**:

```text
IssueSpawnOrder (SLICE-TODODUE-002):
  specId: SPEC-TODODUE / sliceId: SLICE-TODODUE-002
  specRef:         { path: specs/todo-due/spec.md,         gitSha: <blob> }
  verificationRef: { path: specs/todo-due/acceptance.yaml, gitSha: <blob> }
  acceptanceCriteriaIds: [AC-TODODUE-002, AC-TODODUE-003]
  manualRequirementIds:  [MR-TODODUE-001]
  sliceRef:        { path: specs/todo-due/slices/SLICE-TODODUE-002.md, gitSha: <blob> }
  designDeltaRef:  { path: specs/todo-due/design-delta.md,            gitSha: <blob> }
  systemRefs:      [ {artifact: architecture, elementId: ARCH-031, gitSha: <blob>},
                     {artifact: data-model,   elementId: DATA-014, gitSha: <blob>} ]
  dependsOn:       [SLICE-TODODUE-001]
```

### Hop 3 — M22 Design Reviewer（spawn 前に独立審査・AI）— ここで内側ループを回す

M03 が M22 を dispatch。M22 は M21 と **AI コンテキストを共有しない**（自己評価の排除）。
2 段で審査する。

**決定的 tier（機械検査）**: 被覆/排他 ✓、ID 安定 ✓、additive（既存 system 要素を書き換えない）✓、
参照実在（DATA-014 / ARCH-031 が system 層に在る）✓、依存 DAG 非循環 ✓、名前衝突なし ✓、埋め込み禁止 ✓。→ pass。

**整合性 tier（層別・LLM 判断）**: ここでわざと 1 件の不整合を仕込む。SLICE-002 が共有基盤
`compareByDue(a,b)`（ARCH-031 の公開シェイプ）ではなく `sortByDue(list)` を前提に書いていた、とする。これは
**スライス層 ↔ 参照した system 要素の背反**に当たる:

```text
DesignScorecard:
  specId: SPEC-TODODUE
  graderTiers: { deterministic: pass, consistency: fail }
  findings:
    - id: F1
      severity: blocking
      layer: slice
      refs: [SLICE-TODODUE-002, ARCH-031]          # ← M21 の逆引きキー
      statement: SLICE-002 が参照する sortByDue は共有基盤 ARCH-031 の公開シェイプ compareByDue に反する
      evidence: ARCH-031.publicShape=[isOverdue, compareByDue] / SLICE-002.componentDesign=sortByDue
  verdict: changes-requested      # blocking が非空
  failureClass: design_failure
```

**内側ループが回る**: M03 が spec を `designing` へ差し戻す → M21 が finding の逆引きキー
（`SLICE-TODODUE-002`, `ARCH-031`）で **その 1 スライスだけ** 再設計（全体は触らない）→ 公開シェイプに
合わせて修正 → 再シグナル → M22 再審査 → 今度は blocking 空で `verdict: pass`。M03 が
`design-reviewed → decomposed` を書く。

> 勘所: **被覆/排他（集合演算）は「最悪の分割（全 AC を 1 スライス）」でも通る**。だから整合性 tier が要る。
> そして scorecard の `refs[]` が「該当箇所だけ直す」局所性を与える。設計差し戻しに**新機構を作らない**
> （AC drift の逆引きを再利用・ADR-0002 D24）。

### Hop 4 — M03 Coordinator が issue を spawn 【ここから先は spec が無い＝穴】

`decomposed` で M03 が issue を 2 件投稿する。issue は**契約を埋め込まず参照だけ**持つ（D8）。
`SLICE-001` は依存なし、`SLICE-002` は `dependsOn: [SLICE-001]`。M03 が DAG を消費して dispatch 順・並行度を
決める（tracer-bullet 縦切り優先）。

ここで **M03 の spec がまだ無い**。状態機械・ラベル排他・ロック・worktree・dispatch の具体は未確定（§7）。
通し図はこの先「こう動くはず」を**仮で**辿るが、実装着手にはまず M03 の起票が要る。

### Hop 5 — M05 resolve（IssueContract へ機械投影・決定的コード）

M03 が `SLICE-001` の issue を dispatch する時、M05 を呼ぶ。M05 は IssueSpawnOrder を **uniform な
`IssueSource`** に正規化し、版固定参照の content を解決して、**join/copy だけ**で IssueContract を組む。
判断はしない（判断が要るなら上流の欠落）。

```text
IssueContract (SLICE-TODODUE-001):
  productGoal: Todo に期限を保存・編集できる                # narrative から copy
  userStory:   ユーザーとして Todo に期限を設定したい
  scope: { include: [...], exclude: [...] }
  acceptanceCriteria:
    - id: AC-TODODUE-001
      severity: blocker
      behavior: Todo の作成/編集時に期限を設定できる。null も許す。   # behaviorRef から
      verification: { method: api_test, expected: [ "POST→GET 往復", "省略時 null" ] }  # verificationRef から
  redLines: [ 既存 Todo を破壊しない ]
  tech_stack: <architecture 要素の共有技術決定>            # systemRefs の architecture から copy（greenfield のみ）
```

**drift gate**: M05 は dispatch 時に `acFingerprints` と現版の AC ハッシュを照合する。もし誰かが署名後に
`AC-TODODUE-001` の behavior を書き換えていたら、ハッシュ不一致 → **resolve せず差し戻し**（WHAT→著述層で
人間が再署名）。M05 は再署名しない。同一 `IssueSource` なら **byte-identical** な契約を返す（決定性）。

### Hop 6〜8 — M06 生成 / M07・M09 評価 / M08・M10 改善 【すべて spec が無い＝穴】

ここから loop 1 の後半。**いずれも spec ゼロ**なので、辿れるのは「こうつながるはず」まで:

- **M06 Generator**: IssueContract を読み、worktree で実装し PR を作る。`SLICE-002` は core/dueDate を
  新規実装（共有基盤）。実サイズが PR を超えると判明したら M21 へ feedback（B5・再 split）。
- **M07 Evaluator + M09 Harness**: PR を独立評価。**M09 が隔離環境で実際に grader を回す**
  （api_test / playwright / unit_test を実コマンドで）→ 証拠付き **EvalScorecard**。ここが
  「mock と production の間の最大の壁」（[README §4.3](README.md)）。
- **human_review ゲート**: `SLICE-002` は `MR-TODODUE-001(tier: human_review)` を背負うので、全 pass でも
  `needs-human-review` へ寄り、人間がタイムゾーン判定を監査する（D17）。
- **M08 Repair / M10 Curator**: 不合格なら Repair が修正指示を出して生成へ戻す（実装内側ループ）。そして
  **loop 1 の完了基準＝その失敗を回帰 eval に昇格**（M10）。北極星の反証「失敗が回帰化されない」を loop 1 で潰す。

通し図はここで**崖**に着く。崖の手前（M20→M21→M22→M05）は具体的に辿れるが、崖の先（M03/M06/M07/M09）は
spec が無く、辿りは仮置きになる。これが「実装着手できる範囲」の正確な輪郭（§7）。

---

## 5. drift は 3 種類ある（共通の逆引きで畳む）

loop 1 を理解する上で「**承認した版と現版がズレたらどう戻すか**」を 3 つ押さえると効く。いずれも
**変更された ID を逆引きして該当箇所だけ**直す（全体再実行しない）のが共通形。

| drift | 何が起きた | 誰が検知 | どう畳む |
| --- | --- | --- | --- |
| AC drift | 署名後に spec.md/acceptance.yaml が変わった | M20（二段検知）/ M05（dispatch 時 gate） | 変更 AC-ID を `approvedAcIds` から外す → 該当スライスだけ再設計・再署名 |
| system 層 drift | system 要素（ドメイン/データ/アーキ）が変わった | M21 | 変更要素 ID を `dependsOnSystem` に持つスライスを**全 spec 横断**で再検証 |
| foundation drift | 共有基盤が後から必要と判明 | M07/監査が**事実**、M10/M21 が**抽出判断** | 新 `sharedFoundations` を **additive** 追加・既存 ID は renumber しない |

> 例（AC drift）: 誰かが `AC-TODODUE-002` の behavior を「赤」→「太字」に変えると、M20 が `acFingerprints`
> 比較でその AC のハッシュ差を検出し、`AC-TODODUE-002` **だけ**を `approvedAcIds` から外す。status は
> 自動的に `co-authoring` へ落ち再署名を促す。M21 は `coversAcIds` 逆引きで `SLICE-002` だけ再設計。
> `SLICE-001` は無傷。**path 単位の diff だけでは「どの AC が変わったか」を返せない**ので、AC 単位ハッシュが要る。

---

## 6. 勘所 — なぜこの形なのか（4 本の柱）

通しを辿った今なら、設計を立たせている 4 本の柱が具体例に結びつく。

1. **WHAT/HOW 分離 + 二層 SoT**: 人間は spec.md（AC）だけ書いて署名（Hop 1）。下の設計・実装は AI 著者。
   契約は埋め込まず `path@blobSHA` 参照で渡し、SHA 固定で drift を機械検知（Hop 5 の gate）。
2. **対称な二重ループ + 独立評価**: 設計（M21↔M22・Hop 3）と実装（M06↔M07・Hop 7）に、それぞれ
   「独立評価者 → scorecard → 逆引きで該当だけ差し戻し」が入る。状態は LLM でなく M03 が書く。
3. **薄い実装層 / contract altitude**: 設計は「決定 + モジュール間 seam/契約」までしか書かない（system 層の
   公開シェイプだけ・内部は M06 に委ねる）。厳格さは **コード/grader/schema validation** で強制（M05 は
   決定的コード、grader は実コマンド）し、プロンプトは薄く保つ。
4. **ブートストラップ**: loop 1 を**手で**作り、以降は loop 1 自身を使って loop 2+ を作る（ドッグフード）。
   ＝あなたが言った「上記の計画の仕組みを使って進める」。

---

## 7. 実装着手の地図（specされた / 穴）

通し図で「具体的に辿れた所」と「崖」を実装可否に翻訳する。

| 範囲 | モジュール | spec | 今できること |
| --- | --- | --- | --- |
| 著述 → 設計 → 審査 → resolve | M20 / M21 / M22 / M05 | 下書き | 契約と振る舞いは具体化済み。**確定**させれば前半は着手可 |
| 背骨 | **M03 Coordinator** | **無し** | 状態機械・ラベル排他・ロック・worktree・dispatch・DAG 消費が未確定。**ここが最優先の穴** |
| 実装 | **M06 Generator** | **無し** | IssueContract→PR の adapter（worktree・CLI 起動）が未確定 |
| 評価 | **M07 + M09** | **無し** | 隔離実行 + 実 grader（最大の壁）が未確定 |
| 改善（薄） | M08 / M10 | 無し | repair 1 周・回帰昇格を薄く |

**loop 1 を縦に 1 本閉じる最小実装順**（[README §8](README.md) の指示と整合）:

1. 前半 4 つ（M20/M21/M22/M05）を**下書き → 確定**に上げ、ドリフト（M20 の状態三者不一致など）を解消。
2. **M03 を起票**（背骨。これが無いと何も繋がらない）。状態機械二段・dispatch・DAG 消費を確定。
3. M06（薄い adapter）→ M07+M09（実 grader 1〜2 種）→ M08/M10（薄く）で縦 1 本を閉じる。
4. loop 1 が閉じたら、**実際に現れた契約**から M01 共通契約モデルを抽出する（先に作らない・D1）。

> 完了基準（loop 1）: 1 機能が人間の HOW 無しで PR 化され、証拠で採点され、**その失敗が回帰ケースとして
> 捕捉される**。本書の Todo 例がこの 4 ステップで端から端まで通れば、loop 1 は閉じている。

---

## 8. この図の使い方（次の一手）

- **読んで穴を突く**: §4 を上から読み、引っかかった Hop を指摘する。それが仕様の説明不足か、あなたの理解の穴。
- **崖を埋める**: 実装着手の現実的な次手は **M03 の起票**（§7）。前半 4 つの確定と並行できる。
- **ドッグフード**: 前半が動けば、この Todo 例の代わりに「次に作りたい機能」を spec.md に書き、loop 1 に
  流す。以降の仕組み構築自体が loop 1 の最初の利用者になる（柱 4）。

> 本書は仕様が動くたびに陳腐化しうる。modules/ と ADR を SoT とし、齟齬を見つけたら本書を直す（SoT にしない）。
