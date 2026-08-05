# Shared contracts

`contracts/`は`apps/control-plane`（Go）と`apps/agentops`（TypeScript）が順応する、
language-neutralなPublished Languageである。JSON SchemaとOpenAPIを、どちらか一方のapplication
packageへ所有させずrepository rootに置く。

- PostgreSQLを介するRegistration、job、runner result、release receipt等のpayloadは、
  `db/control-store/migrations/`のSQL contractと組で扱う。
- Control API contractはoperator/client境界を定義する。TypeScript runnerへのjob dispatch transportではない。
- credential broker HTTPのrequest/responseは秘密そのものを永続化せず、role capabilityと短期tokenの
  security boundaryを定義する。

Go↔TypeScriptのdurable business coordinationの正本はPostgreSQL `agentops_control`である。ただし、
credential broker HTTP、CONNECT egress proxy、runner shared volume、`agentopsctl`のactual container操作は別の
security/runtime contractであり、「共有contractがある」ことを「すべてDB経由」と読み替えない。
なおlifecycle mode/drain fenceはPostgreSQLへ保存する。

当面は両applicationと`db/`・`contracts/`を同じrepository revisionからreleaseする。独立releaseを可能にする
compatibility rangeやexpand/contract migrationはまだ契約していない。変更時は
[ADR-0021](../docs/decisions/ADR-0021-go-typescript-application-boundaries.md)と各schemaのversion gateに従う。
