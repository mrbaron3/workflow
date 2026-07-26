# 概要

Control API のみをブラウザ境界とする Registration 管理ダッシュボードを追加しました。Registration の作成・更新・無効化と、Issue Monitor / PR Monitor / Forwarder / Execution / Queue の desired / actual / freshness / last-good / recovery、MONITOR_ONLY / ACTIVE、再試行結果を異常優先で表示します。

## セキュリティ境界

- exact loopback Host / Origin、HttpOnly SameSite=Strict セッション、memory-only CSRF、Sec-Fetch-Site を検証
- bearer credential をブラウザコードへ公開せず、一回限り bootstrap token からセッションを確立
- 任意 command、host path、image、mount、credential、unsafe repository identity を strict schema で拒否
- version fence と idempotency key により update / disable / retry の重複と stale 操作を拒否
- Control プロセスは loopback backend と最小 publication proxy に分離し、container lifecycle/socket へアクセスしない

## Designflow lineage

- request changes: `workflow-ciso05-dashboard-r01-request-changes`
- approved revision: `workflow-ciso05-dashboard-r02`
- approved bundle: `sha256:4f7357e099985d2dce5c1941b8ee25231e3208808727362b9f87d725084b70fa`
- capability reconciliation: `sha256:f67fed2c8de6836072cd8fb34ce53e70bf3801717989ba9c1dc25a1793d5a1db`
- approval: `workflow-ciso05-dashboard-r02-approve`

## 検証

- design schema / digest / decision / 7 capability cross-trace
- `go test -race ./...`
- `go vet ./...`
- `npm test`
- `npm run test:postgres`
- `npm run test:dashboard`
- `npm run build`
- `npm audit --audit-level=high`
- standard OCI build
- Apple Container smoke（read-only root、cap-drop ALL、host/socket mount なし）

検証の機械可読な詳細は `evidence/ciso-05/implementation-validation.json` に保存しています。

Closes #15
