# Control Plane (Go)

`apps/control-plane` は AgentOps の Go アプリケーションです。ライフサイクル制御、Control API とダッシュボード、GitHub App の短期 credential 発行、ローカル配備操作を担当します。TypeScript アプリケーションは `apps/agentops` に分離されています。

両アプリケーション間の durable な橋渡しは PostgreSQL です。キュー、lease、実行結果、監査、ライフサイクル状態は共有 DB schema を介して受け渡し、Go/TypeScript のソースコードを相互 import しません。GitHub credential broker の HTTP は権限を限定した短期 credential の境界であり、アプリケーション状態の正本ではありません。

## Entrypoints

- `cmd/agentops-control`: Control API、ダッシュボード、監視・supervisor、管理コマンド
- `cmd/agentopsctl`: ローカルコンテナ構成の build/start/drain/deploy/status 操作
- `cmd/agentops-github-broker`: GitHub App credential broker
- `cmd/agentops-github-credential-helper`: runner/triage から broker を利用する Git/`gh` helper

## Shared contracts

- `db/control-store/migrations`: PostgreSQL control-store の canonical migrations
- `contracts/control-store/v1`: DB を介する job/result payload の JSON Schema
- `contracts/control-api/v1`: Control API の OpenAPI contract
- `contracts/github-credential/v1`: credential broker の request/response contract
- `contracts/designflow/contract-v1.0.0-rc.1/contracts/v1`: canonical Designflow schemas

Designflow schemas は起動時検証のため `internal/designgate/schemas` に埋め込みます。canonical schema から同期する場合はリポジトリルートで次を実行します。

```bash
go generate ./apps/control-plane/internal/designgate
```

## Validation

リポジトリルートから実行します。

```bash
go test ./apps/control-plane/...
go build ./apps/control-plane/cmd/...
```

PostgreSQL integration tests も実行する場合は、破棄可能な test database を `AGENTOPS_TEST_DATABASE_URL` に指定します。未指定時は対象テストだけ skip されます。
