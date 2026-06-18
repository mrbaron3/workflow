---
featureId: <FEATURE>          # AC/MR ID の接頭辞。例: STAKE
area: backend                 # frontend | backend | fullstack | infra
epicId: <EPIC-ID>
status: draft                 # draft | co-authoring | approved
approval:                     # status: approved の時のみ埋める（署名の人間可読記録）
  approvedAcIds: []           # 署名対象の AC-ID 集合（drift 再署名はこのサブセット: O4）
  approvedAt: ""              # ISO8601。署名日時
  approvedBy: ""              # 署名者（役割名）。版固定 ref は ApprovedSpecRef に保存し issue へ転記（O2）
---

# <機能名> 仕様

> このファイルは **Development Department への入力契約**であり、人間が AC の **behavior**（WHAT）を
> 著す source of truth（オーサリング SoT）。grader 向けの `verification` は本ファイルに書かず、
> 同じ epic ディレクトリの **`acceptance.yaml`** に AC-ID をキーで分離する（ADR-0001 D15・O1 反転）。
>
> 書くもの / 書かないもの:
>
> - **書く（= 採点対象の WHAT・人間可読）**: 概要・スコープ・前提条件・受け入れ要件の
>   `behavior`・レッドライン。ステータス遷移・失敗時の返還・エラー挙動など「観測可能で金が動く」
>   振る舞いは、散文にせず **必ず受け入れ要件（AC）へ昇格**させる。
> - **書かない（= grader 向け HOW）**: `verification`(method / expected) は **`acceptance.yaml`** へ。
>   内部シーケンス図・コントラクト関数内部・実装手順は **M21 Design Planner** が detailed-design
>   （Tier1/Tier2）として生成する。人間が先に書くと解空間を縛り、二重管理になる。
> - **ここに置かない（= 別票）**: 自動採点できない要件（原子性・再入防止・マルチシグ・
>   タイムロック・監査/人間レビュー前提）は、本ファイルではなく
>   `manual-requirements.md`（要審査要件票）へ分離する。

## 概要

<この機能は誰の何の価値を実現するか（why）。v1 からの変更点があれば併記。>
<= Issue Contract の `productGoal` / `userStory` の源泉。>

## スコープ

### 対象

- <この機能に含む振る舞い>

### 対象外

- <明示的に含めないもの。スコープ膨張のガード。空にしない。>

## 前提条件

- <成立を前提とする状態・他機能・外部条件>

## 受け入れ要件

> 自動採点可能な AC のみをここに置く（B 方針）。各 AC は安定 ID を持ち、`behavior`（人間可読の WHAT）
> のみを記す。grader 向けの `verification` は **`acceptance.yaml`** に AC-ID をキーで書く（O1 反転）。
>
> - `id`: `AC-<FEATURE>-NNN`。一度振ったら**変えない**（acceptance.yaml / scorecard / evidence /
>   repair / Tier2 スライスが参照する join キー）。
> - `severity`: `blocker`（落ちたら出荷不可）/ `major` / `minor`。
> - `behavior`: 観測可能な振る舞いを一文で。**人間が書く。**
> - `subArea`: 受け入れ要件サブ見出し（= **分割境界ヒント**）。M21 が PR サイズへ分解する際に使う。
>   1:1 で issue ではない（β: ADR-0001 D10）。
>
> 自動採点できない要件（`verification.method` に `manual` を使いたくなるもの）は、ここではなく
> `manual-requirements.md` 行き。本ファイルの全 AC は acceptance.yaml に自動採点 method を持つこと。

### <サブ領域A: 例「操作」>

```yaml
acceptanceCriteria:
  - id: AC-<FEATURE>-001
    severity: blocker
    behavior: "<ユーザー観測の振る舞い。例: 申請成功後 My Portfolio にリダイレクトする>"
    subArea: "操作"
```

### <サブ領域B: 例「ステータス・失敗時挙動」>

> ここを忘れない。金が動く保証（遷移・返還・タイムアウト復旧）は最重要 AC。
> 散文の「ステータス遷移ルール」「返還ルール」を、必ずこの形へ昇格させる。

```yaml
acceptanceCriteria:
  - id: AC-<FEATURE>-010
    severity: blocker
    behavior: "<失敗時の観測可能な結果。例: ブロードキャスト後に失敗したら充当した残高を返還する>"
    subArea: "ステータス・失敗時挙動"
  - id: AC-<FEATURE>-011
    severity: blocker
    behavior: "<例: タイムアウト後に遅延着金を検知したら自動で Completed に復旧する>"
    subArea: "ステータス・失敗時挙動"
```

## レッドライン

> 実装が**絶対にしてはならない**こと。Generator への明示的禁止。

- <例: ローカル状態だけで永続化したふりをしない>
- <例: 実装後に合格基準を緩めない>

## 補助: ユーザー観測フロー（任意）

> ユーザーが観測するレベルの happy / error パスのみ。内部コンポーネントの
> シーケンス図（OctoLink → コントラクト → ウォレットインフラ等）は**ここに書かない**
> ——それは HOW であり M21 Design Planner が生成する。

1. <ユーザー視点の手順>
