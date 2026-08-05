# PostgreSQL control store

`db/control-store/migrations/`は、Go control-planeとTypeScript AgentOpsのdurable business coordinationを
定義する共有SQL contractである。Registration、cursor、delivery、lifecycle mode/generation/drain fence、
monitor broker request/response、job、
lease/attempt、result/progress、release receipt、artifact URI/digest metadataの唯一の正本は
PostgreSQL `agentops_control`とする。`LISTEN/NOTIFY`はwake-up hintであり、query/reconciliationが
truth-recovery pathである。

migrationは番号順・append-onlyで、version/name/checksumを変更しない。通常の
`apps/control-plane` / `apps/agentops` consumerはverify-onlyで起動し、DDLを変更しない。
`agentopsctl`が起動する短命なowner-only admin processだけがadvisory lock下のsingle transactionで
forward migrationとleast-privilege role bootstrapを行う。down migrationでdurable rowを消さず、
current schemaを理解するforward fixで回復する。

DBはすべてのruntime接続を吸収しない。GitHub credential broker HTTPとcredential helper、CONNECT egress
proxy、checkout/large artifact用shared volume、container build/start/stopとactual topology操作は別の
security/runtime contractである。secretや短期token、大きなartifact本体をDBへ保存せず、必要な
identity、URI、digest、receipt linkだけをdurableに束縛する。lifecycle mode/drain fenceはDBに置くが、
runtime command自体をDB jobにはしない。

両consumerがexact schema/checksumを要求するため、当面は`apps/control-plane`、`apps/agentops`、
`db/`、`contracts/`、`deploy/`を同じrepository revisionとしてreleaseする。詳細は
[ADR-0013](../../docs/decisions/ADR-0013-postgresql-control-plane-source-of-truth.md)、
[ADR-0016](../../docs/decisions/ADR-0016-agentopsctl-lifecycle-authority.md)、
[ADR-0021](../../docs/decisions/ADR-0021-go-typescript-application-boundaries.md)を参照する。
