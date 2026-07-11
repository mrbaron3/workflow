# Target-rooted authoring 受け入れ要件

> このファイルは Development Department への入力契約であり、人間が機能の **WHAT（受け入れ基準）** を
> 著す source of truth。frontmatter は持たない（meta・署名は ApprovedSpecRef が持つ）。
>
> **WHAT/HOW 境界**: 本 spec が定義するのは「著述チェーン（spawn → 著述 → 署名 → Issue 分解 →
> 契約）が、**外部 target repo の docs ツリーと git に対して成立する**」という観測可能な性質。
> 組織（この repo）と開発対象（target repo）の**接点は target 設定（config.target）に閉じる**
> （⑭人間確定の repo 分離モデル — コマンドごとの root 手指定を既定経路にしない。override の
> 有無・CLI の形は実装の裁量）。git 操作の実現手段・パス表現の内部形式も裁量。
>
> **現状（D4 ギャップ・⑭発見）**: 実行半分（worktree/grader/panel/跨 target 回帰）は外部
> target 対応済み・grounded 実証済み。著述半分が harness repo 固定 — spawn の root は
> ライブラリ層にのみ存在し設定から導かれず、署名の git 操作（dirty 検査・blob 版固定）は
> この repo の cwd に固定、分解・契約の外部 repo での成立は未検証。roadmap の取り込み
> （`plan-roadmap --seed <path>`）は path 非依存で既に外部ファイルを食える。
> 正本: docs/NORTH_STAR_PLAN.md §2 横断 D4・§5 repo 分離モデル。
>
> **参照する固定制約**: `LANG-authoring-005`（署名＝改竄検知可能な版固定を産む判断点）・
> `LANG-authoring-006`（ApprovedSpecRef の実体: path＋commit/blob gitSha）・
> `DOM-planning-004`（SpecState — 同一性は spec dir のパス・署名ライフサイクルの永続先）・
> `DOM-planning-005`（ApprovedSpecRef は不変な版固定の値オブジェクト）・
> `DOM-planning-009`（再取込/再 spawn は additive かつ冪等・署名済みを決して上書きしない）。
> dependsOn は acceptance.yaml に置く。

## 意図（roadmap-planner が定めた outcome）

- 機能: Target-rooted authoring
- outcome（価値・なぜ今）: spawn-specs / sign / spawn-issues / contract-draft の著述チェーンが、外部 target repo の docs/requirements・docs/_system・git に対して働く: spawn した要求 stub は target repo に生え、署名は target の git の committed blob を版固定し、design lint は target の system 層を解決する。harness 自身（repo='.'）への従来動作は不変（additive）。
- 計画の木リンク: feature=FEAT-010 epic=EPIC-05

## サブ機能一覧

> この一覧は設計層への分割境界ヒントであり、slice ではない。

| ID | サブ機能 | 優先度 |
| --- | --- | --- |
| TROOT-A | 外部 root への spawn（要求 stub が target repo に生える） | 高 |
| TROOT-B | 署名の版固定が target の git に効く（dirty 拒否・drift 検知含む） | 高 |
| TROOT-C | 分解・契約の target 解決と、harness 自身の従来動作不変 | 高 |

## TROOT-A 外部 root への spawn

**ユーザーストーリー**

- 誰が: 人間（テーマの WHAT 著者）と進行管理役
- 何を: in-plan feature の要求 stub を、開発対象であるテーマ repo 自身の docs ツリーに生やす
- なぜ: テーマ repo が自分の WHAT を所有する（自己記述性 — 組織を外しても要求履歴と契約が
  テーマ repo 単体で完結する・⑭確定モデル）

**事前条件**

- 外部 target の設定（config.target）が、docs ツリーと git repo を持つ外部 repo を指している
- planning tree（epics/features）は組織の store にある（ADR-0001 — 組織状態は複製しない）

**受け入れ基準**

- **[AC-TROOT-001] 正常系: spawn した要求 stub が外部 repo に生え、追跡され、冪等**
  - Given config.target が外部 repo を指し、in-plan で未 spawn の feature がある
  - When spawn-specs を実行する
  - Then 要求 stub（requirements.md＋acceptance.yaml）が**外部 repo の docs/requirements/
    配下**に生え、SpecState がその dir を追跡して feature と双方向リンクし、再実行は冪等で
    著述済み内容を上書きしない（従来保証が外部 root でも成立）

## TROOT-B 署名の版固定が target の git に効く

**ユーザーストーリー**

- 誰が: 人間（署名者）
- 何を: 外部 repo に著述した要求契約を、その repo の git 履歴に対して版固定する
- なぜ: 署名は改竄検知可能な版固定（固定制約参照）。コードと同じ git に契約が pin されて
  初めて、テーマ repo 単体で「何が約束されたか」を検証できる

**受け入れ基準**

- **[AC-TROOT-002] 正常系: 署名は外部 repo の committed blob を版固定し、drift 検知も外部 repo と突合する**
  - Given 外部 repo 内の著述済み要求 dir（要求 doc と acceptance.yaml が外部 repo で commit 済み）
  - When 署名する
  - Then 版固定（ApprovedSpecRef）の commit/blob 識別子は**外部 repo の git** の committed
    内容を指し、署名後の照合は clean なら approved を、外部 repo 側でファイルが変わったら
    drift を報告する

- **[AC-TROOT-003] 異常系: 未 commit の変更がある外部 dir への署名は拒否される**
  - Given 外部 repo の要求 doc に未 commit の変更がある
  - When 署名する
  - Then 署名は拒否され（版固定は committed blob のみ — 従来の整合性保証を外部でも維持）、
    SpecState は署名前の状態から変異しない

## TROOT-C 分解・契約の target 解決と従来動作の不変

**ユーザーストーリー**

- 誰が: 進行管理役（Issue 分解・契約起案）
- 何を: 外部 repo の署名済み要求から、外部 repo の system 層を参照する Issue と契約を起こす。
  同時に、harness 自身を target とする従来運用を一切変えない
- なぜ: 分解の整合（dependsOnSystem の解決）は target の設計正本に対して意味を持つ。
  そして組織自身の改善ループ（③）はこれまでどおり回り続けなければならない

**受け入れ基準**

- **[AC-TROOT-004] 正常系: Issue 分解と契約が外部 repo の文書を源に成立する**
  - Given 外部 repo の署名済み要求 dir に issues.yaml（外部 repo の docs/_system の要素 id を
    dependsOnSystem で参照）が著述されている
  - When spawn-issues → contract-draft を実行する
  - Then design lint は**外部 repo の system 層**で参照 id を解決して通し、ISSUE が組織の
    store に採番・着地し、契約は署名 AC を源に外部 repo 相対の file-glob scope を持つ

- **[AC-TROOT-005] 後方互換: harness 自身への著述チェーンは従来と同一**
  - Given config.target が harness 自身（repo='.'）を指す従来構成
  - When spawn-specs / 署名 / spawn-issues / contract-draft を実行する
  - Then 生成場所（docs/requirements/）・署名の版固定先（自 repo の git）・system 層の解決
    （既存の sibling→grandparent 規則）・legacy docs/specs dir の扱いを含め、従来と同一の
    挙動になる（additive）

**非機能要件**

- 決定論: 外部 repo は一時ディレクトリ上の実 git repo（fixture）で全 AC を実 vitest 内で
  検証できる（実テーマ repo・ネットワーク不要）。
- 可観測性: spawn/署名/分解の結果は従来どおり store に残る（ADR-0001 — 組織状態の SoT は
  1 つ・target repo へ第二の store を作らない）。
- 互換性: additive — 外部 target 未設定・従来構成では挙動差ゼロ。

**完了条件**

- 自動テスト: 外部 spawn（冪等含む）／外部署名（blob pin・drift・dirty 拒否）／外部分解・契約
  ／harness 自身の後方互換 各 1 以上。
- 運用観測（released 後・grader 対象外）: テーマ repo（M4・YouTube 分析）scaffold 後の EPIC-01
  で、spawn → to-spec 著述 → 署名 → 分解 → 契約 → drive の一気通貫を grounded 観測する
  （D1/D3 の観測と合流 — NORTH_STAR_PLAN §5）。

## レッドライン

> 実装が絶対にしてはならないこと。

- 署名の版固定意味論を緩めない: committed blob のみを pin する・dirty は拒否・改竄検知
  （drift）を外部 repo でも成立させる（`LANG-authoring-005`/`006` の保証を弱めない）。
- 組織状態（store・planning tree）を target repo へ複製しない・target 側に第二の store を
  作らない（ADR-0001）。
- 既存の SpecState / 署名済み契約（legacy docs/specs を含む）の同一性・内容を書き換えない
  （`DOM-planning-009` — 再 spawn/再取込は署名済みに触れない）。
- 外部 repo の git 履歴を変更しない（著述チェーンが行うのはファイル生成と読み取り・状態記録
  のみ。commit は人間/テーマ側の行為）。
- 合格基準（既存テスト）を弱体化しない。
