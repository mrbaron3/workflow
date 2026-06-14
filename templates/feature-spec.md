# <機能名> 仕様

> このファイルは **Development Department への入力契約**であり、人間が事前に作成する
> source of truth。Department はこの spec.md を受け取り、受け入れ要件を gradable な
> Issue Contract（`src/domain/schema.ts` の `IssueContract`）へ投影して実行する。
>
> 書くもの / 書かないもの:
>
> - **書く（= 採点対象の WHAT）**: 概要・スコープ・前提条件・受け入れ要件（自動採点可能なもののみ）・レッドライン。
>   ステータス遷移・失敗時の返還・エラー挙動など「観測可能で金が動く」振る舞いは、
>   散文にせず **必ず受け入れ要件（AC）へ昇格**させる。
> - **書かない（= AI が生成する HOW）**: 内部シーケンス図・コントラクト関数内部・
>   Webhook ペイロード詳細・実装手順。これらは Department が `detailed-design` 相当として生成する。
>   人間が先に書くと解空間を不必要に縛り、二重管理になる。
> - **ここに置かない（= 別票）**: 自動採点できない要件（原子性・再入防止・マルチシグ・
>   タイムロック・監査/人間レビュー前提）は、本ファイルではなく
>   `manual-requirements.md`（要審査要件票）へ分離する。

## メタ

| 項目 | 値 |
| --- | --- |
| feature id | `<FEATURE>`（AC ID の接頭辞に使う。例: `STAKE`） |
| area | `frontend` \| `backend` \| `fullstack` \| `infra` |
| epic | `<EPIC-ID>` |
| status | `draft` \| `co-authoring` \| `approved` |

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

> 自動採点可能な AC のみをここに置く（B 方針）。各 AC は安定 ID を持ち、
> `IssueContract.acceptanceCriteria` へ 1:1 で投影される。
>
> - `id`: `AC-<FEATURE>-NNN`。一度振ったら**変えない**（scorecard / evidence / repair が参照する）。
> - `severity`: `blocker`（落ちたら出荷不可）/ `major` / `minor`。
> - `behavior`: 観測可能な振る舞いを一文で。
> - `verification.method`: 自動採点メソッドのみ ——
>   `build` / `typecheck` / `unit_test` / `api_test` / `db_state_check` /
>   `playwright` / `secrets_scan` / `scope_check` / `llm_rubric`。
>   `manual` を使いたくなったら、それは `manual-requirements.md` 行き。
> - `verification.expected`: grader が実際に判定できる具体的な期待値（最低 1 行）。
>
> `behavior` は人間が書き、`verification`（method / expected）は AI と協業で確定する。
>
> サブ見出し（### 単位）は **Issue の分割境界**を兼ねる。Department はサブ領域ごとに
> PR サイズの Issue Contract へ分解する。

### <サブ領域A: 例「操作」>

```yaml
acceptanceCriteria:
  - id: AC-<FEATURE>-001
    severity: blocker
    behavior: "<ユーザー観測の振る舞い。例: 申請成功後 My Portfolio にリダイレクトする>"
    verification:
      method: playwright
      expected:
        - "<具体的・検証可能な期待値>"
```

### <サブ領域B: 例「ステータス・失敗時挙動」>

> ここを忘れない。金が動く保証（遷移・返還・タイムアウト復旧）は最重要 AC。
> 散文の「ステータス遷移ルール」「返還ルール」を、必ずこの形へ昇格させる。

```yaml
acceptanceCriteria:
  - id: AC-<FEATURE>-010
    severity: blocker
    behavior: "<失敗時の観測可能な結果。例: ブロードキャスト後に失敗したら充当した残高を返還する>"
    verification:
      method: api_test
      expected:
        - "<例: 失敗イベント注入後、GET /balance が減算前の値に戻っている>"
  - id: AC-<FEATURE>-011
    severity: blocker
    behavior: "<例: タイムアウト後に遅延着金を検知したら自動で Completed に復旧する>"
    verification:
      method: db_state_check
      expected:
        - "<例: 遅延着金注入後、レコード status が Completed かつ二重減算されていない>"
```

## レッドライン

> 実装が**絶対にしてはならない**こと。Generator への明示的禁止。

- <例: ローカル状態だけで永続化したふりをしない>
- <例: 実装後に合格基準を緩めない>

## 補助: ユーザー観測フロー（任意）

> ユーザーが観測するレベルの happy / error パスのみ。内部コンポーネントの
> シーケンス図（OctoLink → コントラクト → ウォレットインフラ等）は**ここに書かない**
> ——それは HOW であり Department が生成する。

1. <ユーザー視点の手順>
