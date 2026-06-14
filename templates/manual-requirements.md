# <機能名> 要審査要件票

> B 方針の「別管理」側。`feature-spec.md` の受け入れ要件は**自動採点可能なもの**に限る。
> 自動採点できない要件——セキュリティ性質・原子性・権限管理・監査前提など——を
> ここに分離して追跡する。
>
> これらは Department の自動評価ループでは緑チェックを偽装せず、`verification` の
> `tier` に応じて人間 / 監査 / 静的解析へルーティングする。契約からは消さず、
> 「採点はできないが満たすべき要件」として残すのが目的。

## メタ

| 項目 | 値 |
| --- | --- |
| feature id | `<FEATURE>`（`feature-spec.md` と同じ接頭辞） |
| 関連 spec | `<feature>/spec.md` |

## 要審査要件

> - `id`: `MR-<FEATURE>-NNN`。AC とは別系列の安定 ID。
> - `severity`: `blocker` / `major` / `minor`。
> - `requirement`: 満たすべき性質を一文で。
> - `tier`: 検証の担い手 ——
>   `audit`（外部/内部監査）/ `static_analysis`（静的解析ツール）/
>   `human_review`（人間レビュー）/ `integration_test`（自動化はできるが harness 標準 grader 外）。
> - `verifier`: 実際に確認する主体（役割名・ツール名）。
> - `evidence`: 確認の証跡として何を残すか。

```yaml
manualRequirements:
  - id: MR-<FEATURE>-001
    severity: blocker
    requirement: "<例: Vault コントラクトが再入攻撃を防止していること>"
    tier: audit
    verifier: "<例: スマートコントラクト監査>"
    evidence: "<例: 監査レポートの該当項目>"
  - id: MR-<FEATURE>-002
    severity: blocker
    requirement: "<例: 残高減算とレコード作成が同一トランザクション内で原子的であること>"
    tier: integration_test
    verifier: "<例: バックエンド統合テスト（手書き）>"
    evidence: "<例: 障害注入テストのログ>"
  - id: MR-<FEATURE>-003
    severity: major
    requirement: "<例: コントラクト管理者権限がマルチシグ + タイムロックで管理されること>"
    tier: human_review
    verifier: "<例: リリース承認者>"
    evidence: "<例: デプロイ設定のレビュー記録>"
```
